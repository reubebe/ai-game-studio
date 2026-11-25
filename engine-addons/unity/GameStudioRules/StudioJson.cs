using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace GameStudio.Rules
{
    // Small JSON reader and writer for rule programs and telemetry. Unity's JsonUtility cannot read
    // free-form objects, and the template ships no packages. Values come back as null, bool, double,
    // string, List<object> or Dictionary<string, object> (keys in file order).
    public static class StudioJson
    {
        const int MaxDepth = 200;

        public static object Parse(string text, out string error)
        {
            error = "";
            var reader = new Reader(text ?? "");
            try
            {
                reader.SkipSpace();
                object value = reader.ReadValue(0);
                reader.SkipSpace();
                if (!reader.AtEnd) throw new FormatException("unexpected text after the value at " + reader.Position);
                return value;
            }
            catch (FormatException e)
            {
                error = e.Message;
                return null;
            }
        }

        class Reader
        {
            readonly string s;
            int i;
            public Reader(string text) { s = text; }
            public bool AtEnd => i >= s.Length;
            public int Position => i;

            public void SkipSpace()
            {
                while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
            }

            FormatException Fail(string what) => new FormatException(what + " at " + i);

            public object ReadValue(int depth)
            {
                if (depth > MaxDepth) throw Fail("nested too deeply");
                if (AtEnd) throw Fail("unexpected end");
                char c = s[i];
                if (c == '{') return ReadObject(depth);
                if (c == '[') return ReadArray(depth);
                if (c == '"') return ReadString();
                if (Word("true")) return true;
                if (Word("false")) return false;
                if (Word("null")) return null;
                if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                throw Fail("unexpected character '" + c + "'");
            }

            bool Word(string w)
            {
                if (string.CompareOrdinal(s, i, w, 0, w.Length) != 0) return false;
                i += w.Length;
                return true;
            }

            Dictionary<string, object> ReadObject(int depth)
            {
                var o = new Dictionary<string, object>();
                i++;
                SkipSpace();
                if (!AtEnd && s[i] == '}') { i++; return o; }
                while (true)
                {
                    SkipSpace();
                    if (AtEnd || s[i] != '"') throw Fail("expected a key");
                    string key = ReadString();
                    SkipSpace();
                    if (AtEnd || s[i] != ':') throw Fail("expected ':'");
                    i++;
                    SkipSpace();
                    o[key] = ReadValue(depth + 1);
                    SkipSpace();
                    if (AtEnd) throw Fail("unexpected end");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return o; }
                    throw Fail("expected ',' or '}'");
                }
            }

            List<object> ReadArray(int depth)
            {
                var a = new List<object>();
                i++;
                SkipSpace();
                if (!AtEnd && s[i] == ']') { i++; return a; }
                while (true)
                {
                    SkipSpace();
                    a.Add(ReadValue(depth + 1));
                    SkipSpace();
                    if (AtEnd) throw Fail("unexpected end");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return a; }
                    throw Fail("expected ',' or ']'");
                }
            }

            string ReadString()
            {
                i++;
                var b = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw Fail("unterminated string");
                    char c = s[i++];
                    if (c == '"') return b.ToString();
                    if (c < ' ') throw Fail("control character in string");
                    if (c != '\\') { b.Append(c); continue; }
                    if (AtEnd) throw Fail("unterminated escape");
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': b.Append('"'); break;
                        case '\\': b.Append('\\'); break;
                        case '/': b.Append('/'); break;
                        case 'b': b.Append('\b'); break;
                        case 'f': b.Append('\f'); break;
                        case 'n': b.Append('\n'); break;
                        case 'r': b.Append('\r'); break;
                        case 't': b.Append('\t'); break;
                        case 'u':
                            if (i + 4 > s.Length) throw Fail("short \\u escape");
                            if (!int.TryParse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int code)) throw Fail("bad \\u escape");
                            b.Append((char)code);
                            i += 4;
                            break;
                        default: throw Fail("bad escape");
                    }
                }
            }

            double ReadNumber()
            {
                int start = i;
                if (s[i] == '-') i++;
                while (i < s.Length && "0123456789+-.eE".IndexOf(s[i]) >= 0) i++;
                string token = s.Substring(start, i - start);
                if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out double v)) throw Fail("bad number '" + token + "'");
                return v;
            }
        }

        public static string Write(object value)
        {
            var b = new StringBuilder();
            WriteValue(b, value);
            return b.ToString();
        }

        static void WriteValue(StringBuilder b, object value)
        {
            switch (value)
            {
                case null: b.Append("null"); break;
                case bool flag: b.Append(flag ? "true" : "false"); break;
                case string text: WriteString(b, text); break;
                case double d: WriteNumber(b, d); break;
                case float f: WriteNumber(b, f); break;
                case int n: b.Append(n.ToString(CultureInfo.InvariantCulture)); break;
                case long n: b.Append(n.ToString(CultureInfo.InvariantCulture)); break;
                case IDictionary<string, object> map:
                    b.Append('{');
                    bool first = true;
                    foreach (var pair in map)
                    {
                        if (!first) b.Append(',');
                        first = false;
                        WriteString(b, pair.Key);
                        b.Append(':');
                        WriteValue(b, pair.Value);
                    }
                    b.Append('}');
                    break;
                case System.Collections.IEnumerable list:
                    b.Append('[');
                    bool firstItem = true;
                    foreach (object item in list)
                    {
                        if (!firstItem) b.Append(',');
                        firstItem = false;
                        WriteValue(b, item);
                    }
                    b.Append(']');
                    break;
                default: WriteString(b, value.ToString()); break;
            }
        }

        static void WriteNumber(StringBuilder b, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { b.Append("null"); return; }
            b.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder b, string s)
        {
            b.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else b.Append(c);
                        break;
                }
            }
            b.Append('"');
        }
    }
}
