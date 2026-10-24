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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
        Function target = function.isThunk() ? function.getThunkedFunction(true) : null;
        return record("entry", addr(function.getEntryPoint()),
                      "name", function.getName(),
                      "namespace", function.getParentNamespace().getName(true),
                      "external", function.isExternal(),
                      "thunk", function.isThunk(),
                      "thunk_target", target == null ? null : addr(target.getEntryPoint()),
                      "body_min", addr(function.getBody().getMinAddress()),
                      "body_max", addr(function.getBody().getMaxAddress()),
                      "signature", function.getSignature().getPrototypeString());
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
        DecompileResults result = decompiler.decompileFunction(function, 120, monitor);
        if (!result.decompileCompleted() || result.getDecompiledFunction() == null) {
            output.put("status", "error");
            output.put("error", result.getErrorMessage());
            return;
        }
        output.put("status", "ok");
        output.put("decompilation", result.getDecompiledFunction().getC());
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

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) {
            throw new IllegalArgumentException("expected output path and mode");
        }
        Map<String, Object> output = record("schema", 1);
        if (args[1].equals("index")) {
            runIndex(output);
        } else if (args[1].equals("function") || args[1].equals("all")) {
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
