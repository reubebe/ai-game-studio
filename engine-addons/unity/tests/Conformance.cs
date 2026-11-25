using System;
using System.Collections.Generic;
using System.IO;
using GameStudio.Rules;

// Runs packages/rules-core/src/conformance/fixtures.json against the C# rule runtime.
// Mirrors engine-addons/godot/gamestudio_runtime/tests/run_conformance.gd. Exit code 0 when every
// step matches the TypeScript runtime's recorded results. Run by packages/rules-core/src/runtimes.test.ts.
public static class Conformance
{
    class ScriptedHost : IRuleHost
    {
        public readonly List<object> Calls = new List<object>();
        readonly Dictionary<string, object> queries;
        readonly Dictionary<string, object> results;

        public ScriptedHost(Dictionary<string, object> q, Dictionary<string, object> r) { queries = q; results = r; }

        public Dictionary<string, object> Call(string fn, Dictionary<string, object> args)
        {
            Calls.Add(new Dictionary<string, object> { { "fn", fn }, { "args", new Dictionary<string, object>(args) } });
            return results.TryGetValue(fn, out object r) && r is Dictionary<string, object> d ? new Dictionary<string, object>(d) : null;
        }

        public object Query(string fn, Dictionary<string, object> args)
        {
            if (!queries.TryGetValue(fn, out object answer)) throw new RuleError($"No scripted answer for '{fn}'");
            if (answer is Dictionary<string, object> table)
            {
                string by = table.TryGetValue("by", out object b) ? b as string : "";
                string key = RulesVM.ToText(args.TryGetValue(by ?? "", out object k) ? k : null);
                var values = table.TryGetValue("values", out object v) ? v as Dictionary<string, object> : null;
                return values != null && values.TryGetValue(key, out object found) ? found : table["default"];
            }
            return answer;
        }
    }

    static Dictionary<string, object> D(object o) => o as Dictionary<string, object> ?? new Dictionary<string, object>();

    static bool DeepEqual(object a, object b)
    {
        a = RulesVM.Norm(a);
        b = RulesVM.Norm(b);
        if (a == null || b == null) return a == null && b == null;
        if (a is Dictionary<string, object> x)
        {
            if (!(b is Dictionary<string, object> y) || x.Count != y.Count) return false;
            foreach (var pair in x) if (!y.TryGetValue(pair.Key, out object other) || !DeepEqual(pair.Value, other)) return false;
            return true;
        }
        if (a is System.Collections.IList l)
        {
            if (!(b is System.Collections.IList m) || l.Count != m.Count) return false;
            for (int i = 0; i < l.Count; i++) if (!DeepEqual(l[i], m[i])) return false;
            return true;
        }
        return a.GetType() == b.GetType() && a.Equals(b);
    }

    public static int Main(string[] argv)
    {
        object data = StudioJson.Parse(File.ReadAllText(argv[0]), out string parseError);
        if (data == null)
        {
            Console.WriteLine("GSTUDIO_CONFORMANCE FAIL cannot read fixtures: " + parseError);
            return 2;
        }
        int failures = 0, steps = 0;
        foreach (object s in (List<object>)D(data)["scenarios"])
        {
            var scenario = D(s);
            var vm = new RulesVM();
            string loadError = vm.Load(scenario["program"]);
            if (loadError != "")
            {
                Console.WriteLine($"FAIL {scenario["name"]}: {loadError}");
                failures++;
                continue;
            }
            int index = 0;
            foreach (object st in (List<object>)scenario["steps"])
            {
                var step = D(st);
                index++;
                steps++;
                var host = new ScriptedHost(D(scenario["queries"]), D(scenario["results"]));
                RunResult r = vm.Run((string)step["event"], D(step["payload"]), host);
                var actual = new Dictionary<string, object>
                {
                    { "handled", r.Handled },
                    { "halted", r.Halted },
                    { "error", r.Error != null },
                    { "errorNode", r.ErrorNode },
                    { "variables", new Dictionary<string, object>(vm.Variables) },
                    { "calls", host.Calls },
                    { "logs", r.Logs },
                    { "trace", r.Trace },
                };
                foreach (var pair in D(step["expect"]))
                {
                    actual.TryGetValue(pair.Key, out object got);
                    if (DeepEqual(pair.Value, got)) continue;
                    failures++;
                    Console.WriteLine($"FAIL {scenario["name"]} step {index} ({pair.Key}): expected {StudioJson.Write(pair.Value)}, got {StudioJson.Write(got)}");
                }
            }
        }
        // Number formatting edge cases, checked against formatNumber() in format.ts.
        var formats = new (double, string)[] { (3, "3"), (-0.0, "0"), (2.5, "2.5"), (1.0 / 3, "0.33"), (2.675, "2.68"), (-1.005, "-1"), (0.1 + 0.2, "0.3"), (-2.5, "-2.5"), (1e15, "1000000000000000"), (0.004, "0"), (-0.004, "0"), (1.005, "1"), (8.345, "8.35"), (0.125, "0.13"), (-0.125, "-0.12"), (2.999, "3"), (-2, "-2") };
        foreach (var (input, expected) in formats)
        {
            string got = RulesVM.FormatNumber(input);
            if (got == expected) continue;
            failures++;
            Console.WriteLine($"FAIL format {input}: expected {expected}, got {got}");
        }
        Console.WriteLine(failures == 0 ? $"GSTUDIO_CONFORMANCE PASS {steps} steps" : $"GSTUDIO_CONFORMANCE FAIL {failures} mismatches in {steps} steps");
        return failures == 0 ? 0 : 1;
    }
}
