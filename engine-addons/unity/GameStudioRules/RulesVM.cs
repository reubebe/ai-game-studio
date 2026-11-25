using System;
using System.Collections.Generic;
using System.Globalization;

namespace GameStudio.Rules
{
    // Thrown by hosts (and the VM) when a rule cannot continue. Node is the graph node to highlight.
    public class RuleError : Exception
    {
        public readonly string Node;
        public RuleError(string message, string node = null) : base(message) { Node = node; }
    }

    // What a game offers its rules. Values are double, bool or string.
    public interface IRuleHost
    {
        // Actions with side effects. May return named results for later nodes, or null.
        Dictionary<string, object> Call(string fn, Dictionary<string, object> args);
        // Pure reads of game state.
        object Query(string fn, Dictionary<string, object> args);
    }

    public class RunResult
    {
        public bool Handled;
        public bool Halted;
        public readonly List<string> Trace = new List<string>();
        public readonly List<string> Logs = new List<string>();
        public int Statements;
        public string Error;
        public string ErrorNode;
    }

    // Interpreter for Game Studio rule programs (IR version 1).
    //
    // Mirrors packages/rules-core/src/interpret.ts and engine-addons/godot/gamestudio_runtime/rules_vm.gd
    // statement for statement; all three are checked against packages/rules-core/src/conformance/fixtures.json
    // (engine-addons/unity/tests/Conformance.cs runs them here).
    public class RulesVM
    {
        public const int IrVersion = 1;
        public const int MaxStatements = 20000;
        public const int MaxRepeat = 1000;

        static readonly Dictionary<string, int> OpArity = new Dictionary<string, int>
        {
            {"add", 2}, {"sub", 2}, {"mul", 2}, {"div", 2}, {"idiv", 2}, {"mod", 2}, {"min", 2}, {"max", 2},
            {"neg", 1}, {"abs", 1}, {"floor", 1}, {"ceil", 1}, {"round", 1},
            {"eq", 2}, {"neq", 2}, {"lt", 2}, {"lte", 2}, {"gt", 2}, {"gte", 2},
            {"and", 2}, {"or", 2}, {"not", 1}, {"text", 1}, {"concat", 2},
        };

        class Halt : Exception { }

        Dictionary<string, object> program = new Dictionary<string, object>();
        Dictionary<string, object> decls = new Dictionary<string, object>();
        Dictionary<string, object> handlers = new Dictionary<string, object>();
        public Dictionary<string, object> Variables { get; private set; } = new Dictionary<string, object>();
        public string GraphId => program.TryGetValue("graphId", out object id) && id is string s ? s : "";

        // Per-run state.
        Dictionary<string, object> payload;
        IRuleHost host;
        Dictionary<string, Dictionary<string, object>> temps;
        RunResult result;
        string current;
        string eventName;
        int maxStatements;

        // Returns "" on success or an error message.
        public string Load(object parsed)
        {
            var p = parsed as Dictionary<string, object>;
            if (p == null) return "Rule program is not a JSON object";
            if (!(p.TryGetValue("irVersion", out object version) && version is double v && v == IrVersion))
                return "Unsupported rule program version: " + (p.TryGetValue("irVersion", out object raw) ? Convert.ToString(raw, CultureInfo.InvariantCulture) : "missing");
            if (!(p.TryGetValue("handlers", out object h) && h is Dictionary<string, object> hs) || !(p.TryGetValue("variables", out object d) && d is Dictionary<string, object> ds))
                return "Rule program is missing handlers or variables";
            program = p;
            handlers = hs;
            decls = ds;
            Reset();
            return "";
        }

        public void Reset()
        {
            Variables = new Dictionary<string, object>();
            foreach (var pair in decls)
            {
                var decl = pair.Value as Dictionary<string, object>;
                Variables[pair.Key] = decl != null && decl.TryGetValue("initial", out object initial) ? initial : null;
            }
        }

        // Restores saved values; names the program does not declare are ignored.
        public void SetVariables(Dictionary<string, object> values)
        {
            foreach (var pair in values) if (decls.ContainsKey(pair.Key)) Variables[pair.Key] = Norm(pair.Value);
        }

        public bool HasHandler(string ev) => handlers.ContainsKey(ev);

        public RunResult Run(string ev, Dictionary<string, object> eventPayload, IRuleHost ruleHost, int limit = MaxStatements)
        {
            var r = new RunResult();
            if (!handlers.TryGetValue(ev, out object handlerValue)) return r;
            r.Handled = true;
            payload = new Dictionary<string, object>();
            if (eventPayload != null) foreach (var pair in eventPayload) payload[pair.Key] = Norm(pair.Value);
            host = ruleHost;
            temps = new Dictionary<string, Dictionary<string, object>>();
            result = r;
            current = null;
            eventName = ev;
            maxStatements = limit;
            var handler = handlerValue as Dictionary<string, object>;
            try
            {
                ExecBlock(handler != null && handler.TryGetValue("body", out object body) ? body as List<object> : null);
            }
            catch (Halt)
            {
                r.Halted = true;
            }
            catch (RuleError e)
            {
                r.Error = e.Message;
                r.ErrorNode = e.Node ?? current;
            }
            catch (Exception e)
            {
                r.Error = e.Message;
                r.ErrorNode = current;
            }
            host = null;
            result = null;
            return r;
        }

        static string Str(Dictionary<string, object> o, string key) => o.TryGetValue(key, out object v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : "";
        static Dictionary<string, object> Obj(Dictionary<string, object> o, string key) => o.TryGetValue(key, out object v) && v is Dictionary<string, object> d ? d : new Dictionary<string, object>();
        static List<object> List(Dictionary<string, object> o, string key) => o.TryGetValue(key, out object v) && v is List<object> l ? l : new List<object>();

        RuleError Fail(string message) => new RuleError(message, current);

        void ExecBlock(List<object> stmts)
        {
            if (stmts == null) return;
            foreach (object item in stmts)
            {
                result.Statements += 1;
                if (result.Statements > maxStatements) throw Fail($"Stopped after {maxStatements} steps (possible runaway rule)");
                var stmt = item as Dictionary<string, object> ?? new Dictionary<string, object>();
                if (stmt.TryGetValue("node", out object node) && node is string nodeId && nodeId != "") current = nodeId;
                string kind = Str(stmt, "s");
                switch (kind)
                {
                    case "trace":
                    {
                        string id = Str(stmt, "node");
                        current = id;
                        if (result.Trace.Count == 0 || result.Trace[result.Trace.Count - 1] != id) result.Trace.Add(id);
                        break;
                    }
                    case "set":
                        ExecSet(stmt);
                        break;
                    case "call":
                        ExecCall(stmt);
                        break;
                    case "if":
                    {
                        object cond = Eval(Obj(stmt, "cond"));
                        if (!(cond is bool yes)) throw Fail("Branch condition must be true or false");
                        ExecBlock(List(stmt, yes ? "then" : "else"));
                        break;
                    }
                    case "switch":
                    {
                        string key = ToText(Eval(Obj(stmt, "value")));
                        var cases = Obj(stmt, "cases");
                        ExecBlock(cases.TryGetValue(key, out object branch) ? branch as List<object> : List(stmt, "default"));
                        break;
                    }
                    case "repeat":
                    {
                        object n = Eval(Obj(stmt, "count"));
                        if (!(n is double count) || double.IsNaN(count) || double.IsInfinity(count)) throw Fail("Repeat count must be a number");
                        int times = (int)Math.Max(0, Math.Min(MaxRepeat, Math.Floor(count)));
                        string index = Str(stmt, "index");
                        for (int i = 0; i < times; i++)
                        {
                            temps[index] = new Dictionary<string, object> { { "index", (double)i } };
                            ExecBlock(List(stmt, "body"));
                        }
                        temps.Remove(index);
                        break;
                    }
                    case "halt":
                        throw new Halt();
                    default:
                        throw Fail($"Unknown statement '{kind}'");
                }
            }
        }

        void ExecSet(Dictionary<string, object> stmt)
        {
            string name = Str(stmt, "var");
            if (!decls.TryGetValue(name, out object declValue)) throw Fail($"Unknown variable '{name}'");
            object value = Eval(Obj(stmt, "value"));
            string type = declValue is Dictionary<string, object> decl ? Str(decl, "type") : "";
            if (type == "text") value = ToText(value);
            bool ok = (type == "number" && value is double) || (type == "boolean" && value is bool) || (type == "text" && value is string);
            if (!ok) throw Fail($"Variable '{name}' needs {type}");
            Variables[name] = value;
        }

        void ExecCall(Dictionary<string, object> stmt)
        {
            var args = new Dictionary<string, object>();
            foreach (var pair in Obj(stmt, "args")) args[pair.Key] = Eval(pair.Value as Dictionary<string, object> ?? new Dictionary<string, object>());
            string fn = Str(stmt, "fn");
            string outName = stmt.ContainsKey("out") ? Str(stmt, "out") : "";
            if (fn == "core.log")
            {
                result.Logs.Add(ToText(args.TryGetValue("message", out object message) ? message : ""));
                if (outName != "") temps[outName] = new Dictionary<string, object>();
                return;
            }
            if (host == null) throw Fail("No host is connected");
            Dictionary<string, object> res = host.Call(fn, args);
            if (outName != "")
            {
                var record = new Dictionary<string, object>();
                if (res != null) foreach (var pair in res) record[pair.Key] = Norm(pair.Value);
                temps[outName] = record;
            }
        }

        object Eval(Dictionary<string, object> expr)
        {
            string kind = Str(expr, "e");
            switch (kind)
            {
                case "const":
                    return Norm(expr.TryGetValue("v", out object v) ? v : null);
                case "var":
                {
                    string name = Str(expr, "name");
                    if (!Variables.TryGetValue(name, out object value)) throw Fail($"Unknown variable '{name}'");
                    return value;
                }
                case "param":
                {
                    string name = Str(expr, "name");
                    if (!payload.TryGetValue(name, out object value) || value == null) throw Fail($"Event '{eventName}' is missing '{name}'");
                    return value;
                }
                case "temp":
                {
                    string field = Str(expr, "field");
                    if (!temps.TryGetValue(Str(expr, "name"), out var record) || !record.TryGetValue(field, out object value)) throw Fail($"Value '{field}' is not available yet");
                    return value;
                }
                case "op":
                {
                    string op = Str(expr, "op");
                    List<object> raw = List(expr, "args");
                    if (!OpArity.TryGetValue(op, out int arity) || raw.Count != arity) throw Fail($"Operator '{op}' has the wrong number of inputs");
                    var values = new List<object>();
                    foreach (object a in raw) values.Add(Eval(a as Dictionary<string, object> ?? new Dictionary<string, object>()));
                    return ApplyOp(op, values);
                }
                case "query":
                {
                    var args = new Dictionary<string, object>();
                    foreach (var pair in Obj(expr, "args")) args[pair.Key] = Eval(pair.Value as Dictionary<string, object> ?? new Dictionary<string, object>());
                    string fn = Str(expr, "fn");
                    if (host == null) throw Fail("No host is connected");
                    object answer = host.Query(fn, args);
                    if (answer == null) throw Fail($"Query '{fn}' returned no value");
                    return Norm(answer);
                }
            }
            throw Fail($"Unknown expression '{kind}'");
        }

        double Num(object v, string op)
        {
            if (!(v is double d) || double.IsNaN(d)) throw Fail($"Operator '{op}' expects a number, received {TypeName(v)}");
            return d;
        }

        bool Bool(object v, string op)
        {
            if (!(v is bool b)) throw Fail($"Operator '{op}' expects true/false, received {TypeName(v)}");
            return b;
        }

        static string TypeName(object v) => v is double ? "number" : v is bool ? "boolean" : v is string ? "string" : "nothing";

        static bool Same(object a, object b)
        {
            if (a is double x && b is double y) return x == y;
            if (a is bool p && b is bool q) return p == q;
            if (a is string s && b is string t) return string.Equals(s, t, StringComparison.Ordinal);
            return false;
        }

        object ApplyOp(string op, List<object> args)
        {
            object a = args[0];
            object b = args.Count > 1 ? args[1] : null;
            switch (op)
            {
                case "add": return Num(a, op) + Num(b, op);
                case "sub": return Num(a, op) - Num(b, op);
                case "mul": return Num(a, op) * Num(b, op);
                case "div":
                {
                    double d = Num(b, op);
                    if (d == 0) throw Fail("Division by zero");
                    return Num(a, op) / d;
                }
                case "idiv":
                {
                    double d = Num(b, op);
                    if (d == 0) throw Fail("Division by zero");
                    return Math.Floor(Num(a, op) / d);
                }
                case "mod":
                {
                    double d = Num(b, op);
                    if (d == 0) throw Fail("Modulo by zero");
                    double n = Num(a, op);
                    return ((n % d) + d) % d;
                }
                case "min": return Math.Min(Num(a, op), Num(b, op));
                case "max": return Math.Max(Num(a, op), Num(b, op));
                case "neg": return -Num(a, op);
                case "abs": return Math.Abs(Num(a, op));
                case "floor": return Math.Floor(Num(a, op));
                case "ceil": return Math.Ceiling(Num(a, op));
                case "round": return Math.Floor(Num(a, op) + 0.5);
                case "eq": return Same(a, b);
                case "neq": return !Same(a, b);
                case "lt": return Num(a, op) < Num(b, op);
                case "lte": return Num(a, op) <= Num(b, op);
                case "gt": return Num(a, op) > Num(b, op);
                case "gte": return Num(a, op) >= Num(b, op);
                case "and": { bool x = Bool(a, op); bool y = Bool(b, op); return x && y; }
                case "or": { bool x = Bool(a, op); bool y = Bool(b, op); return x || y; }
                case "not": return !Bool(a, op);
                case "text": return ToText(a);
                case "concat": return ToText(a) + ToText(b);
            }
            throw Fail($"Unknown operator '{op}'");
        }

        // Whole numbers of every C# type become double, so values compare and print as in TypeScript.
        public static object Norm(object v)
        {
            switch (v)
            {
                case int i: return (double)i;
                case long l: return (double)l;
                case float f: return (double)f;
                default: return v;
            }
        }

        public static string ToText(object v)
        {
            switch (v)
            {
                case double d: return FormatNumber(d);
                case int i: return FormatNumber(i);
                case float f: return FormatNumber(f);
                case bool b: return b ? "true" : "false";
                case string s: return s;
            }
            return "";
        }

        // Mirrors formatNumber() in packages/rules-core/src/format.ts.
        public static string FormatNumber(double x)
        {
            if (double.IsNaN(x)) return "nan";
            if (double.IsInfinity(x)) return x > 0 ? "inf" : "-inf";
            if (x == Math.Floor(x) && Math.Abs(x) < 1e15) return ((long)x).ToString(CultureInfo.InvariantCulture);
            // Two steps on purpose: a fused multiply-add (IL2CPP builds go through a C++ compiler) would
            // round x * 100 + 0.5 once instead of twice and could print a different last digit.
            double scaled = x * 100;
            double cents = Math.Floor(scaled + 0.5);
            bool negative = cents < 0;
            double magnitude = Math.Abs(cents);
            double whole = Math.Floor(magnitude / 100);
            int frac = (int)(magnitude - whole * 100);
            string text = whole < 9e15 ? ((long)whole).ToString(CultureInfo.InvariantCulture) : whole.ToString("F0", CultureInfo.InvariantCulture);
            if (frac != 0)
            {
                string digits = frac.ToString("00", CultureInfo.InvariantCulture);
                if (digits.EndsWith("0", StringComparison.Ordinal)) digits = digits.Substring(0, 1);
                text += "." + digits;
            }
            return (negative && magnitude != 0 ? "-" : "") + text;
        }
    }
}
