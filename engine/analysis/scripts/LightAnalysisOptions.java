// Pre-analysis script for very large libraries (e.g. LibreOffice libsclo.so, ~100k functions).
// Turns off the analyzers that dominate import time and that scoped decompilation does not
// need. Symbols (ELF .symtab, DWARF) and call references stay on: they are what make scoped
// evidence readable. Unknown option names are reported and skipped, never fatal.
import ghidra.app.script.GhidraScript;

public class LightAnalysisOptions extends GhidraScript {
    private static final String[] DISABLED = {
        "Decompiler Parameter ID",
        "Aggressive Instruction Finder",
        "Embedded Media",
        "Condense Filler Bytes",
        "Variadic Function Signature Override",
    };

    @Override
    protected void run() throws Exception {
        for (String option : DISABLED) {
            try {
                setAnalysisOption(currentProgram, option, "false");
                println("light analysis: disabled " + option);
            } catch (Exception error) {
                println("light analysis: option not present: " + option);
            }
        }
    }
}
