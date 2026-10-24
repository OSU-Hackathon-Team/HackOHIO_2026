# 08 — Stretch: Compiled-Binary Target (only if all CP2 gates are green by H16)

A compiled target shows judges that REA is not "just reading JavaScript". It is **replay-only**
in the demo. It doesn't run live on stage.

## Option A (preferred): .NET assembly — no native decompiler needed

REA's README says static .NET inspection works without Hopper/Ghidra/IDA.

1. Check `fixtures/rea/tools.json` for the .NET tool(s). **Don't guess the name.** Search the
   catalog for `dotnet`, `assembly`, `managed` or `il`.
2. Build a tiny class library (needs the .NET 8 SDK):

```bash
mkdir -p targets/src/tipcalc && cd targets/src/tipcalc
dotnet new classlib -n TipCalc -o . --force
```

```csharp
// targets/src/tipcalc/PercentEngine.cs
namespace TipCalc;

public enum Op { Add, Subtract, Multiply, Divide }

public static class PercentEngine
{
    // Calculator-style "%": after + or −, x% means x% OF the running value; after × or ÷ it means x/100.
    public static double ResolvePercent(double running, double percent, Op lastOp) =>
        lastOp is Op.Add or Op.Subtract ? running * (percent / 100.0) : percent / 100.0;

    public static double SplitWithTip(double bill, double tipPercent, int people)
    {
        if (people <= 0) throw new ArgumentOutOfRangeException(nameof(people));
        var total = bill + ResolvePercent(bill, tipPercent, Op.Add);
        return Math.Round(total / people, 2, MidpointRounding.AwayFromZero);
    }
}
```

```bash
dotnet build -c Release
cp bin/Release/net8.0/TipCalc.dll ../../build/tipcalc/TipCalc.dll
```

3. Add a collector branch `collectDotnet()` that runs the verified .NET tool(s) and saves the
   decompiled C# as a `SourceSnippet` with `language: "csharp"` and `full_module: false`.
4. Manifest entry: `artifact_type: "dotnet_assembly"`, `live_supported: false` (record once,
   replay in the demo).
5. Step 2 sets `oracle.status: "not_executable"`, because C# can't run in the JS sandbox, so the
   spec card says "requirements not checked against original". That's honest, and it shows why
   the JS oracle matters.

## Option B: native PE via Ghidra (high risk on Windows — "experimental" per REA docs)

Only attempt this on a macOS/Linux teammate machine with Ghidra + JDK 21 already working:
`open_binary` → `search_procedures` / `list_procedures` → `analyze_function` (retained dossier) →
`inspect_analysis_view` for the pseudocode. Record the evidence and replay it. Expect the first
Ghidra query to take minutes. See REA's "first-query deadlines" docs, and set
`REA_GHIDRA_STARTUP_TIMEOUT_MS`.
