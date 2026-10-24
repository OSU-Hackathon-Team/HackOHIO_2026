// Export a Ghidra program index or a selected function as JSON.
// Arguments: output-path index | output-path function address
import com.google.gson.Gson;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;

import java.io.FileWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ExportEvidence extends GhidraScript {
    private Map<String, Object> record(Object... fields) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < fields.length; i += 2) {
            result.put((String) fields[i], fields[i + 1]);
        }
        return result;
    }

    private String addr(Address address) {
        return address.toString();
    }

    private Map<String, Object> describe(Function function) {
        return record("entry", addr(function.getEntryPoint()),
                      "name", function.getName(),
                      "namespace", function.getParentNamespace().getName(true),
                      "external", function.isExternal(),
                      "thunk", function.isThunk(),
                      "body_min", addr(function.getBody().getMinAddress()),
                      "body_max", addr(function.getBody().getMaxAddress()),
                      "signature", function.getSignature().getPrototypeString());
    }

    private void runIndex(Map<String, Object> output) throws Exception {
        List<Map<String, Object>> functions = new ArrayList<>();
        List<Map<String, Object>> calls = new ArrayList<>();
        FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Function function = iterator.next();
            functions.add(describe(function));
            if (!function.isExternal()) {
                InstructionIterator instructions = currentProgram.getListing().getInstructions(function.getBody(), true);
                while (instructions.hasNext()) {
                    Instruction instruction = instructions.next();
                    for (Reference reference : currentProgram.getReferenceManager().getReferencesFrom(instruction.getAddress())) {
                        if (reference.getReferenceType().isCall()) {
                            calls.add(record("caller", addr(function.getEntryPoint()),
                                             "site", addr(instruction.getAddress()),
                                             "target", addr(reference.getToAddress())));
                        }
                    }
                }
            }
        }
        List<Map<String, Object>> imports = new ArrayList<>();
        for (Symbol symbol : currentProgram.getSymbolTable().getExternalSymbols()) {
            imports.add(record("name", symbol.getName(true),
                               "address", addr(symbol.getAddress())));
        }
        List<Map<String, Object>> strings = new ArrayList<>();
        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext()) {
            monitor.checkCancelled();
            Data item = data.next();
            Object value = item.getValue();
            if (value instanceof String) {
                strings.add(record("address", addr(item.getAddress()), "value", value));
            }
        }
        output.put("status", "ok");
        output.put("program", currentProgram.getName());
        output.put("executable_format", currentProgram.getExecutableFormat());
        output.put("language", currentProgram.getLanguageID().toString());
        output.put("compiler", currentProgram.getCompilerSpec().getCompilerSpecID().toString());
        output.put("image_base", addr(currentProgram.getImageBase()));
        output.put("functions", functions);
        output.put("imports", imports);
        output.put("strings", strings);
        output.put("calls", calls);
        output.put("omissions", List.of("indirect call targets and non-function data dependencies may be unresolved"));
    }

    private void runFunction(Map<String, Object> output, String entry) throws Exception {
        Address address = currentProgram.getAddressFactory().getAddress(entry);
        Function function = address == null ? null : currentProgram.getFunctionManager().getFunctionAt(address);
        if (function == null) {
            output.put("status", "missing");
            output.put("entry", entry);
            return;
        }
        output.putAll(describe(function));
        List<Map<String, Object>> instructions = new ArrayList<>();
        List<Map<String, Object>> references = new ArrayList<>();
        InstructionIterator iterator = currentProgram.getListing().getInstructions(function.getBody(), true);
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Instruction instruction = iterator.next();
            Address at = instruction.getAddress();
            instructions.add(record("address", addr(at), "text", instruction.toString()));
            for (Reference reference : currentProgram.getReferenceManager().getReferencesFrom(at)) {
                references.add(record("from", addr(at), "to", addr(reference.getToAddress()),
                                      "type", reference.getReferenceType().toString(),
                                      "external", reference.isExternalReference()));
            }
        }
        output.put("instructions", instructions);
        output.put("references", references);
        if (function.isExternal()) {
            output.put("status", "external");
            output.put("decompilation", null);
            return;
        }
        DecompInterface decompiler = new DecompInterface();
        try {
            decompiler.toggleCCode(true);
            if (!decompiler.openProgram(currentProgram)) {
                output.put("status", "error");
                output.put("error", "decompiler failed to open program");
                return;
            }
            DecompileResults result = decompiler.decompileFunction(function, 120, monitor);
            if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
                output.put("status", "error");
                output.put("error", result.getErrorMessage());
                return;
            }
            output.put("status", "ok");
            output.put("decompilation", result.getDecompiledFunction().getC());
        } finally {
            decompiler.dispose();
        }
    }

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) {
            throw new IllegalArgumentException("expected output path and mode");
        }
        Map<String, Object> output = record("schema", 1);
        if (args[1].equals("index")) {
            runIndex(output);
        } else if (args[1].equals("function") && args.length == 3) {
            runFunction(output, args[2]);
        } else {
            throw new IllegalArgumentException("unknown export mode");
        }
        try (FileWriter writer = new FileWriter(args[0])) {
            new Gson().toJson(output, writer);
        }
    }
}
