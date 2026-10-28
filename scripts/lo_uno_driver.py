"""Drive a headless LibreOffice Calc over UNO with a JSON line protocol.

Runs under the system Python that ships python3-uno (not the engine venv):
    /usr/bin/python3 scripts/lo_uno_driver.py /usr/lib/libreoffice/program/soffice

stdout, one JSON object per line:
    {"op": "ready", "pid": <soffice.bin pid>, "version": "..."}      once, after connecting
    {"id": ..., "observed": {"value": 7.0} | {"text": ".."} | {"error": 532, "text": "#DIV/0!"}}
stdin, one JSON object per line:
    {"op": "eval", "id": "...", "formula": "=1+2*3", "cells": {"B1": 4, "B2": "=B1*2"}}
    {"op": "quit"}
Formulas use the UNO API grammar (English function names, ';' between arguments).
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

import uno  # noqa: E402  (only importable under LibreOffice's Python)
from com.sun.star.beans import PropertyValue  # noqa: E402
from com.sun.star.connection import NoConnectException  # noqa: E402

FORMULA_RESULT_VALUE, FORMULA_RESULT_STRING, FORMULA_RESULT_ERROR = 1, 2, 4
CLEAR_ALL = 1023
TARGET = "A1"


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def find_pid(pipe):
    """The soffice.bin process listening on our pipe (the soffice launcher forks it)."""
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if cmdline and cmdline[0].endswith(b"soffice.bin") and any(pipe.encode() in a for a in cmdline):
            return int(entry.name)
    return None


def connect(soffice, profile, pipe, deadline_seconds=90):
    process = subprocess.Popen(
        [soffice, "--headless", "--invisible", "--nologo", "--norestore", "--nodefault",
         "--nolockcheck", "-env:UserInstallation=" + Path(profile).as_uri(),
         "--accept=pipe,name=%s;urp;StarOffice.ComponentContext" % pipe],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.monotonic() + deadline_seconds
    while True:
        try:
            ctx = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
            return process, ctx
        except NoConnectException:
            if process.poll() is not None and find_pid(pipe) is None:
                raise RuntimeError("soffice exited with code %s before accepting" % process.returncode)
            if time.monotonic() > deadline:
                raise RuntimeError("soffice did not accept a UNO connection in time")
            time.sleep(0.5)


def product_version(ctx):
    provider = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.configuration.ConfigurationProvider", ctx)
    node = PropertyValue("nodepath", 0, "/org.openoffice.Setup/Product", 0)
    access = provider.createInstanceWithArguments(
        "com.sun.star.configuration.ConfigurationAccess", (node,))
    return "%s %s" % (access.getByName("ooName"), access.getByName("ooSetupVersionAboutBox"))


def evaluate(doc, sheet, formula, cells):
    sheet.getCellRangeByName("A1:Z200").clearContents(CLEAR_ALL)
    for name, value in cells.items():
        cell = sheet.getCellRangeByName(name)
        if isinstance(value, str) and value.startswith("="):
            cell.setFormula(value)
        elif isinstance(value, str):
            cell.setString(value)
        else:
            cell.setValue(float(value))
    target = sheet.getCellRangeByName(TARGET)
    target.setFormula(formula)
    doc.calculateAll()
    error = target.getError()
    if error:
        return {"error": int(error), "text": target.getString()}
    kind = target.getPropertyValue("FormulaResultType2")
    if kind == FORMULA_RESULT_STRING:
        return {"text": target.getString()}
    return {"value": target.getValue()}


def read_matrix(sheet, range_name):
    return [list(row) for row in sheet.getCellRangeByName(range_name).getDataArray()]


def operate(doc, sheet, operation, cells, diagnostics=None):
    sheet.getCellRangeByName("A1:Z200").clearContents(CLEAR_ALL)
    for name, value in cells.items():
        cell = sheet.getCellRangeByName(name)
        if isinstance(value, str) and value.startswith("="):
            cell.setFormula(value)
        elif isinstance(value, str):
            cell.setString(value)
        else:
            cell.setValue(float(value))

    kind = operation["type"]
    if kind == "sort_range":
        target = sheet.getCellRangeByName(operation["range"])
        descriptor = list(target.createSortDescriptor())
        properties = {item.Name: item for item in descriptor}
        if "SortFields" not in properties or "ContainsHeader" not in properties:
            raise RuntimeError("Calc range returned an incomplete sort descriptor")

        # Calc exposes either the current descriptor (TableSortField / IsSortColumns) or
        # the deprecated one (util.SortField / SortColumns). Keep the complete descriptor
        # returned by this range and only replace its operation-specific properties.
        if "IsSortColumns" in properties:
            struct_name = "com.sun.star.table.TableSortField"
            ascending_name = "IsAscending"
            columns_name = "IsSortColumns"
        elif "SortColumns" in properties:
            struct_name = "com.sun.star.util.SortField"
            ascending_name = "SortAscending"
            columns_name = "SortColumns"
        else:
            raise RuntimeError("Calc range returned an unsupported sort descriptor")

        fields = []
        for key in operation["keys"]:
            field = uno.createUnoStruct(struct_name)
            field.Field = key["column"]
            setattr(field, ascending_name, key["ascending"])
            fields.append(field)
        # Preserve the declared struct sequence type inside PropertyValue's Any.
        properties["SortFields"].Value = uno.Any("[]" + struct_name, tuple(fields))
        properties["ContainsHeader"].Value = operation["contains_header"]
        properties[columns_name].Value = False  # sort rows using the selected columns as keys
        if diagnostics is not None:
            diagnostics["sort_descriptor"] = [{"name": p.Name, "value": str(p.Value)} for p in descriptor]
        target.sort(tuple(descriptor))
        output_range = operation.get("output_range", operation["range"])
    elif kind == "insert_rows":
        sheet.Rows.insertByIndex(operation["index"], operation["count"])
        output_range = operation["output_range"]
    elif kind == "delete_rows":
        sheet.Rows.removeByIndex(operation["index"], operation["count"])
        output_range = operation["output_range"]
    elif kind == "insert_columns":
        sheet.Columns.insertByIndex(operation["index"], operation["count"])
        output_range = operation["output_range"]
    elif kind == "delete_columns":
        sheet.Columns.removeByIndex(operation["index"], operation["count"])
        output_range = operation["output_range"]
    elif kind == "copy_range":
        destination = sheet.getCellRangeByName(operation["destination_cell"]).getRangeAddress()
        source = sheet.getCellRangeByName(operation["source_range"]).getRangeAddress()
        sheet.copyRange(destination, source)
        output_range = operation["output_range"]
    else:  # clear_range
        sheet.getCellRangeByName(operation["range"]).clearContents(CLEAR_ALL)
        output_range = operation["output_range"]
    doc.calculateAll()
    return {"cells": read_matrix(sheet, output_range)}


def new_document(desktop):
    hidden = PropertyValue("Hidden", 0, True, 0)
    return desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (hidden,))


def main():
    soffice = sys.argv[1]
    pipe = "splice_" + uuid.uuid4().hex
    profile = tempfile.mkdtemp(prefix="lo-profile-")
    process = doc = None
    try:
        process, ctx = connect(soffice, profile, pipe)
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        doc = new_document(desktop)
        sheet = doc.Sheets.getByIndex(0)
        emit({"op": "ready", "pid": find_pid(pipe) or process.pid, "version": product_version(ctx)})
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("op") == "quit":
                break
            try:
                diagnostics = {} if request.get("diagnostics") else None
                if request.get("op") == "operation":
                    # Structural edits persist across Calc requests; isolate each operation case.
                    doc.close(True)
                    doc = new_document(desktop)
                    sheet = doc.Sheets.getByIndex(0)
                    observed = operate(doc, sheet, request["operation"], request.get("cells") or {}, diagnostics)
                else:
                    observed = evaluate(doc, sheet, request["formula"], request.get("cells") or {})
                emit({"id": request["id"], "observed": observed,
                      **({"diagnostics": diagnostics} if diagnostics else {})})
            except Exception as error:  # report per case; LibreOffice keeps running
                emit({"id": request["id"], "observed": None, "error": str(error)})
    except Exception as error:
        emit({"op": "failed", "error": str(error)})
    finally:
        try:
            if doc is not None:
                doc.close(True)
            if process is not None:
                desktop.terminate()
        except Exception:
            pass
        if process is not None:
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    os.environ.setdefault("SAL_USE_VCLPLUGIN", "svp")
    main()
