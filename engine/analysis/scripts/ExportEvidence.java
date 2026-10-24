// Export a Ghidra program index or a selected function as JSON.
// Arguments: output-path index | output-path function address | directory all | directory serve
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
import ghidra.program.model.listing.Parameter;
import ghidra.program.model.listing.Variable;
import ghidra.program.model.pcode.FunctionPrototype;
import ghidra.program.model.pcode.HighFunction;
import ghidra.program.model.pcode.HighSymbol;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.Symbol;

import java.io.FileWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
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
        Function target = function.isThunk() ? function.getThunkedFunction(true) : null;
        return record("entry", addr(function.getEntryPoint()),
                      "name", function.getName(),
                      "namespace", function.getParentNamespace().getName(true),
                      "external", function.isExternal(),
                      "thunk", function.isThunk(),
                      "thunk_target", target == null ? null : addr(target.getEntryPoint()),
                      "body_min", addr(function.getBody().getMinAddress()),
                      "body_max", addr(function.getBody().getMaxAddress()),
                      "signature", function.getSignature().getPrototypeString(),
                      "signature_source", function.getSignatureSource().toString(),
                      "calling_convention", function.getCallingConventionName(),
                      "varargs", function.hasVarArgs(),
                      "noreturn", function.hasNoReturn());
    }

    private Map<String, Object> describeVariable(Variable variable) {
        return record("name", variable.getName(),
                      "type", variable.getDataType() == null ? null :
                          variable.getDataType().getDisplayName(),
                      "length", variable.getLength(),
                      "storage", variable.getVariableStorage() == null ? null :
                          variable.getVariableStorage().toString(),
                      "source", variable.getSource().toString());
    }

    private Map<String, Object> describeHighSymbol(HighSymbol symbol) {
        return record("name", symbol.getName(),
                      "type", symbol.getDataType() == null ? null :
                          symbol.getDataType().getDisplayName(),
                      "size", symbol.getSize(),
                      "storage", symbol.getStorage() == null ? null :
                          symbol.getStorage().toString(),
                      "type_locked", symbol.isTypeLocked(),
                      "name_locked", symbol.isNameLocked(),
                      "hidden_return", symbol.isHiddenReturn());
    }

    private Map<String, Object> describeData(Address target) {
        Data data = currentProgram.getListing().getDefinedDataContaining(target);
        if (data == null) {
            return record("target", addr(target), "status", "undefined");
        }
        Map<String, Object> description = record("target", addr(target), "status", "defined",
                "defined_at", addr(data.getAddress()),
                "type", data.getDataType().getDisplayName(), "length", data.getLength());
        try {
            String value = data.getDefaultValueRepresentation();
            if (value != null) {
                description.put("value_preview", value.substring(0, Math.min(value.length(), 256)));
                description.put("value_truncated", value.length() > 256);
            }
        } catch (Exception error) {
            description.put("value_error", error.toString());
        }
        return description;
    }

    private void runIndex(Map<String, Object> output) throws Exception {
        List<Map<String, Object>> functions = new ArrayList<>();
        List<Map<String, Object>> calls = new ArrayList<>();
        List<Map<String, Object>> dataReferences = new ArrayList<>();
        List<Map<String, Object>> indirectCalls = new ArrayList<>();
        FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Function function = iterator.next();
            functions.add(describe(function));
            if (!function.isExternal()) {
                InstructionIterator instructions = currentProgram.getListing().getInstructions(function.getBody(), true);
                while (instructions.hasNext()) {
                    Instruction instruction = instructions.next();
                    boolean directCall = false;
                    for (Reference reference : currentProgram.getReferenceManager().getReferencesFrom(instruction.getAddress())) {
                        if (reference.getReferenceType().isCall()) {
                            directCall = true;
                            calls.add(record("caller", addr(function.getEntryPoint()),
                                             "site", addr(instruction.getAddress()),
                                             "target", addr(reference.getToAddress())));
                        } else if (reference.getReferenceType().isData()) {
                            dataReferences.add(record("function", addr(function.getEntryPoint()),
                                                      "site", addr(instruction.getAddress()),
                                                      "target", addr(reference.getToAddress()),
                                                      "type", reference.getReferenceType().toString()));
                        }
                    }
                    if (instruction.getFlowType().isCall() && !directCall) {
                        indirectCalls.add(record("caller", addr(function.getEntryPoint()),
                                                 "site", addr(instruction.getAddress()),
                                                 "instruction", instruction.toString()));
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
        output.put("data_references", dataReferences);
        output.put("indirect_calls", indirectCalls);
        output.put("omissions", List.of("indirect call targets and non-function data dependencies may be unresolved"));
    }

    private void runFunction(Map<String, Object> output, String entry,
                             DecompInterface decompiler) throws Exception {
        Address address = currentProgram.getAddressFactory().getAddress(entry);
        Function function = address == null ? null : currentProgram.getFunctionManager().getFunctionAt(address);
        if (function == null) {
            output.put("status", "missing");
            output.put("entry", entry);
            return;
        }
        output.putAll(describe(function));
        List<Map<String, Object>> parameters = new ArrayList<>();
        for (Parameter parameter : function.getParameters()) {
            Map<String, Object> described = describeVariable(parameter);
            described.put("ordinal", parameter.getOrdinal());
            described.put("auto", parameter.isAutoParameter());
            parameters.add(described);
        }
        List<Map<String, Object>> locals = new ArrayList<>();
        for (Variable variable : function.getLocalVariables()) {
            locals.add(describeVariable(variable));
        }
        output.put("listing_parameters", parameters);
        output.put("listing_locals", locals);
        output.put("listing_return", describeVariable(function.getReturn()));
        List<Map<String, Object>> instructions = new ArrayList<>();
        List<Map<String, Object>> references = new ArrayList<>();
        Map<String, Map<String, Object>> referencedData = new LinkedHashMap<>();
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
                if (reference.getReferenceType().isData()) {
                    String target = addr(reference.getToAddress());
                    if (!referencedData.containsKey(target)) {
                        referencedData.put(target, describeData(reference.getToAddress()));
                    }
                }
            }
        }
        output.put("instructions", instructions);
        output.put("references", references);
        output.put("referenced_data", new ArrayList<>(referencedData.values()));
        if (function.isExternal()) {
            output.put("status", "external");
            output.put("decompilation", null);
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
        output.put("decompiler_signature", result.getDecompiledFunction().getSignature());
        HighFunction high = result.getHighFunction();
        if (high != null) {
            FunctionPrototype prototype = high.getFunctionPrototype();
            List<Map<String, Object>> inferredParameters = new ArrayList<>();
            for (int i = 0; i < prototype.getNumParams(); i++) {
                HighSymbol symbol = prototype.getParam(i);
                if (symbol == null) {
                    inferredParameters.add(record("ordinal", i, "status", "unmapped"));
                } else {
                    Map<String, Object> described = describeHighSymbol(symbol);
                    described.put("ordinal", i);
                    inferredParameters.add(described);
                }
            }
            output.put("decompiler_prototype", record(
                    "parameters", inferredParameters,
                    "return_type", prototype.getReturnType() == null ? null :
                        prototype.getReturnType().getDisplayName(),
                    "return_storage", prototype.getReturnStorage() == null ? null :
                        prototype.getReturnStorage().toString(),
                    "model", prototype.getModelName(),
                    "varargs", prototype.isVarArg(),
                    "noreturn", prototype.hasNoReturn(),
                    "has_this", prototype.hasThisPointer()));
            Map<String, HighSymbol> symbolMap = high.getLocalSymbolMap().getNameToSymbolMap();
            List<String> names = new ArrayList<>(symbolMap.keySet());
            Collections.sort(names);
            List<Map<String, Object>> inferredLocals = new ArrayList<>();
            for (String name : names) {
                HighSymbol symbol = symbolMap.get(name);
                if (!symbol.isParameter() && !symbol.isGlobal()) {
                    inferredLocals.add(describeHighSymbol(symbol));
                }
            }
            output.put("decompiler_locals", inferredLocals);
        } else {
            output.put("decompiler_prototype", null);
            output.put("decompiler_locals", null);
            output.put("type_omission", "decompiler high function unavailable");
        }
    }

    private void writeAtomic(Path destination, Map<String, Object> value) throws Exception {
        Path temporary = destination.resolveSibling(destination.getFileName() + ".tmp");
        try (FileWriter writer = new FileWriter(temporary.toFile())) {
            new Gson().toJson(value, writer);
        }
        Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE,
                   StandardCopyOption.REPLACE_EXISTING);
    }

    private void runAll(String outputDirectory, DecompInterface decompiler) throws Exception {
        Path directory = Path.of(outputDirectory);
        Files.createDirectories(directory);
        FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
        int count = 0;
        while (iterator.hasNext()) {
            monitor.checkCancelled();
            Function function = iterator.next();
            Map<String, Object> output = record("schema", 1);
            try {
                runFunction(output, addr(function.getEntryPoint()), decompiler);
            } catch (Exception error) {
                output.put("entry", addr(function.getEntryPoint()));
                output.put("status", "error");
                output.put("error", error.toString());
            }
            writeAtomic(directory.resolve(String.format("%08d.json", count)), output);
            count++;
        }
        writeAtomic(directory.resolve("all_done.json"), record("schema", 1, "count", count));
    }

    private void runServe(String workDirectory, DecompInterface decompiler) throws Exception {
        Path directory = Path.of(workDirectory);
        Files.createDirectories(directory);
        Path request = directory.resolve("request.json");
        Path response = directory.resolve("response.json");
        writeAtomic(directory.resolve("ready.json"), record("schema", 1, "status", "ready"));
        Gson gson = new Gson();
        while (!Files.exists(directory.resolve("stop"))) {
            monitor.checkCancelled();
            if (!Files.exists(request)) {
                Thread.sleep(50);
                continue;
            }
            Map<?, ?> command = gson.fromJson(Files.readString(request), Map.class);
            Files.delete(request);
            Object entry = command == null ? null : command.get("entry");
            Map<String, Object> output = record("schema", 1);
            if (!(entry instanceof String)) {
                output.put("status", "error");
                output.put("error", "request has no function entry");
            } else {
                try {
                    runFunction(output, (String) entry, decompiler);
                } catch (Exception error) {
                    output.put("entry", entry);
                    output.put("status", "error");
                    output.put("error", error.toString());
                }
            }
            writeAtomic(response, output);
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
        } else if (args[1].equals("function") || args[1].equals("all") || args[1].equals("serve")) {
            DecompInterface decompiler = new DecompInterface();
            try {
                decompiler.toggleCCode(true);
                if (!decompiler.openProgram(currentProgram)) {
                    throw new IllegalStateException("decompiler failed to open program");
                }
                if (args[1].equals("all") && args.length == 2) {
                    runAll(args[0], decompiler);
                    return;
                }
                if (args[1].equals("serve") && args.length == 2) {
                    runServe(args[0], decompiler);
                    return;
                }
                if (args[1].equals("function") && args.length == 3) {
                    runFunction(output, args[2], decompiler);
                } else {
                    throw new IllegalArgumentException("invalid function export arguments");
                }
            } finally {
                decompiler.dispose();
            }
        } else {
            throw new IllegalArgumentException("unknown export mode");
        }
        try (FileWriter writer = new FileWriter(args[0])) {
            new Gson().toJson(output, writer);
        }
    }
}
