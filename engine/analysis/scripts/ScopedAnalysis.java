// Import context only; disassemble selected sized symbols without global auto-analysis.
import com.google.gson.*;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.nio.file.*;
import java.util.*;

public class ScopedAnalysis extends GhidraScript {
    private Map<String,Object> row(Object... values) {
        Map<String,Object> result = new LinkedHashMap<>();
        for (int i=0; i<values.length; i+=2) result.put((String)values[i], values[i+1]);
        return result;
    }
    public void run() throws Exception {
        String[] args = getScriptArgs();
        JsonObject request = JsonParser.parseString(Files.readString(Path.of(args[0]))).getAsJsonObject();
        long originalBase = Long.decode(request.get("elf_image_base").getAsString());
        long delta = currentProgram.getImageBase().getOffset() - originalBase;
        int limit = request.get("max_functions").getAsInt();
        int depthLimit = request.get("max_depth").getAsInt();
        int byteLimit = request.get("max_function_bytes").getAsInt();
        if (limit<1 || limit>128 || depthLimit<0 || depthLimit>4 || byteLimit<1 || byteLimit>262144)
            throw new IllegalArgumentException("invalid scoped budget");
        Map<Long,JsonObject> symbols = new HashMap<>();
        for (JsonElement value : request.getAsJsonArray("symbols")) {
            JsonObject symbol = value.getAsJsonObject();
            symbols.put(Long.decode(symbol.get("address").getAsString()) + delta, symbol);
        }
        Deque<long[]> pending = new ArrayDeque<>();
        Set<Long> seen = new HashSet<>();
        for (JsonElement seed : request.getAsJsonArray("seeds"))
            pending.add(new long[]{Long.decode(seed.getAsString()) + delta, 0});
        List<Object> functions = new ArrayList<>(), frontier = new ArrayList<>();
        while (!pending.isEmpty()) {
            monitor.checkCancelled();
            long[] task = pending.removeFirst();
            long entry = task[0]; int depth = (int)task[1];
            if (!seen.add(entry)) continue;
            JsonObject symbol = symbols.get(entry);
            if (symbol==null || functions.size()>=limit || depth>depthLimit) {
                frontier.add(row("entry", Long.toHexString(entry), "reason", symbol==null ?
                    "unknown_symbol_extent" : "scope_budget"));
                continue;
            }
            long size = symbol.get("size").getAsLong();
            if (size<1 || size>byteLimit) {
                frontier.add(row("entry", Long.toHexString(entry), "reason", "function_byte_budget"));
                continue;
            }
            Address start = toAddr(entry), end = start.addNoWrap(size-1);
            AddressSet bounds = new AddressSet(start,end);
            if (!currentProgram.getMemory().getExecuteSet().contains(bounds) ||
                !currentProgram.getMemory().getLoadedAndInitializedAddressSet().contains(bounds))
                throw new IllegalArgumentException("symbol extent is not initialized executable memory");
            DisassembleCommand decode = new DisassembleCommand(start,bounds,true);
            decode.enableCodeAnalysis(false);
            if (!decode.applyTo(currentProgram,monitor) || decode.getDisassembledAddressSet().isEmpty())
                throw new IllegalStateException("bounded disassembly failed at " + start);
            AddressSet body = decode.getDisassembledAddressSet();
            if (!bounds.contains(body)) throw new IllegalStateException("disassembly escaped its boundary");
            Function function = currentProgram.getFunctionManager().getFunctionAt(start);
            if (function==null) {
                CreateFunctionCmd create = new CreateFunctionCmd(symbol.get("name").getAsString(),
                    start,body,SourceType.IMPORTED);
                if (!create.applyTo(currentProgram,monitor)) throw new IllegalStateException(create.getStatusMsg());
            } else function.setBody(body);
            int instructions=0;
            for (Instruction instruction : currentProgram.getListing().getInstructions(body,true)) {
                monitor.checkCancelled(); instructions++;
                for (Reference reference : instruction.getReferencesFrom()) {
                    if (reference.getReferenceType().isCall()) {
                        Address target=reference.getToAddress();
                        if (target.isMemoryAddress()) pending.add(new long[]{target.getOffset(),depth+1});
                        else frontier.add(row("caller",start.toString(),"target",target.toString(),
                            "reason","external_call"));
                    }
                }
                if (instruction.getFlowType().isComputed()) frontier.add(row("caller",start.toString(),
                    "site",instruction.getAddress().toString(),"reason","indirect_flow"));
                for (Address flow : instruction.getFlows())
                    if (instruction.getFlowType().isJump() && !bounds.contains(flow))
                        frontier.add(row("caller",start.toString(),"target",flow.toString(),
                            "reason","branch_outside_symbol_extent"));
            }
            functions.add(row("entry",start.toString(),"name",symbol.get("name").getAsString(),
                "symbol_size",size,"decoded_bytes",body.getNumAddresses(),"instructions",instructions,
                "depth",depth,"boundary_source","ELF symbol extent"));
        }
        if (functions.isEmpty()) throw new IllegalStateException("no scoped function was decoded");
        Map<String,Object> report = row("schema",1,"status","ok","global_auto_analysis",false,
            "image_base",currentProgram.getImageBase().toString(),"functions",functions,
            "frontier",frontier,"coverage","partial; functions outside the selected scope are not analyzed");
        Files.writeString(Path.of(args[1]),new GsonBuilder().setPrettyPrinting().create().toJson(report));
    }
}
