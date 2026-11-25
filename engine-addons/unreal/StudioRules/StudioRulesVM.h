// Interpreter for Game Studio rule programs (IR version 1), in plain C++17 without exceptions or RTTI
// so it builds inside Unreal modules and in a standalone test.
//
// Mirrors packages/rules-core/src/interpret.ts and engine-addons/godot/gamestudio_runtime/rules_vm.gd
// statement for statement. All three are checked against packages/rules-core/src/conformance/fixtures.json
// (engine-addons/unreal/tests/conformance.cpp runs them here). Like the GDScript runtime, errors and
// Stop are carried in member fields and every step checks them.
#pragma once

#include <clocale>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>
#if defined(__APPLE__)
#include <xlocale.h>
#endif

namespace gsrules
{

// A JSON value. Objects keep their keys in file order.
struct Value
{
	enum class Kind
	{
		Null,
		Bool,
		Number,
		String,
		Array,
		Object
	};

	Kind kind = Kind::Null;
	bool flag = false;
	double number = 0.0;
	std::string text;
	std::vector<Value> items;
	std::vector<std::string> keys;

	static Value Boolean(bool b)
	{
		Value v;
		v.kind = Kind::Bool;
		v.flag = b;
		return v;
	}
	static Value Number(double n)
	{
		Value v;
		v.kind = Kind::Number;
		v.number = n;
		return v;
	}
	static Value Text(std::string s)
	{
		Value v;
		v.kind = Kind::String;
		v.text = std::move(s);
		return v;
	}
	static Value Array()
	{
		Value v;
		v.kind = Kind::Array;
		return v;
	}
	static Value Object()
	{
		Value v;
		v.kind = Kind::Object;
		return v;
	}

	bool IsNull() const { return kind == Kind::Null; }
	bool IsBool() const { return kind == Kind::Bool; }
	bool IsNumber() const { return kind == Kind::Number; }
	bool IsString() const { return kind == Kind::String; }
	bool IsArray() const { return kind == Kind::Array; }
	bool IsObject() const { return kind == Kind::Object; }

	// Object access. Find returns nullptr when the key is missing or this is not an object.
	const Value* Find(const std::string& key) const
	{
		if (kind != Kind::Object)
		{
			return nullptr;
		}
		for (size_t i = 0; i < keys.size(); ++i)
		{
			if (keys[i] == key)
			{
				return &items[i];
			}
		}
		return nullptr;
	}
	bool Has(const std::string& key) const { return Find(key) != nullptr; }
	void Set(const std::string& key, Value value)
	{
		kind = Kind::Object;
		for (size_t i = 0; i < keys.size(); ++i)
		{
			if (keys[i] == key)
			{
				items[i] = std::move(value);
				return;
			}
		}
		keys.push_back(key);
		items.push_back(std::move(value));
	}
	void Erase(const std::string& key)
	{
		for (size_t i = 0; i < keys.size(); ++i)
		{
			if (keys[i] == key)
			{
				keys.erase(keys.begin() + static_cast<std::ptrdiff_t>(i));
				items.erase(items.begin() + static_cast<std::ptrdiff_t>(i));
				return;
			}
		}
	}
	size_t Size() const { return items.size(); }

	// Field helpers that fall back quietly, like Dictionary.get() in GDScript.
	std::string Str(const std::string& key) const
	{
		const Value* v = Find(key);
		return v && v->IsString() ? v->text : std::string();
	}
	const Value& Get(const std::string& key) const
	{
		static const Value Empty;
		const Value* v = Find(key);
		return v ? *v : Empty;
	}
};

// ---- JSON ---------------------------------------------------------------------------------------

namespace json_detail
{
inline double ParseDouble(const std::string& token, bool& ok)
{
	const char* start = token.c_str();
	char* end = nullptr;
#if defined(__APPLE__)
	// JSON numbers always use '.', whatever the process locale says.
	static locale_t CLocale = newlocale(LC_NUMERIC_MASK, "C", nullptr);
	const double v = strtod_l(start, &end, CLocale);
#else
	const double v = std::strtod(start, &end);
#endif
	ok = end && *end == '\0' && end != start;
	return v;
}

inline void AppendUtf8(std::string& out, uint32_t code)
{
	if (code < 0x80)
	{
		out.push_back(static_cast<char>(code));
	}
	else if (code < 0x800)
	{
		out.push_back(static_cast<char>(0xC0 | (code >> 6)));
		out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
	}
	else if (code < 0x10000)
	{
		out.push_back(static_cast<char>(0xE0 | (code >> 12)));
		out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
		out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
	}
	else
	{
		out.push_back(static_cast<char>(0xF0 | (code >> 18)));
		out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
		out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
		out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
	}
}

class Reader
{
public:
	explicit Reader(const std::string& source) : S(source) {}

	bool Parse(Value& out, std::string& error)
	{
		SkipSpace();
		if (!ReadValue(out, 0))
		{
			error = Problem + " at byte " + std::to_string(I);
			return false;
		}
		SkipSpace();
		if (I != S.size())
		{
			error = "unexpected text after the value at byte " + std::to_string(I);
			return false;
		}
		return true;
	}

private:
	const std::string& S;
	size_t I = 0;
	std::string Problem;

	bool Fail(const char* what)
	{
		Problem = what;
		return false;
	}

	void SkipSpace()
	{
		while (I < S.size() && (S[I] == ' ' || S[I] == '\t' || S[I] == '\n' || S[I] == '\r'))
		{
			++I;
		}
	}

	bool Word(const char* word)
	{
		const std::string w(word);
		if (S.compare(I, w.size(), w) != 0)
		{
			return false;
		}
		I += w.size();
		return true;
	}

	bool ReadValue(Value& out, int depth)
	{
		if (depth > 200)
		{
			return Fail("nested too deeply");
		}
		if (I >= S.size())
		{
			return Fail("unexpected end");
		}
		const char c = S[I];
		if (c == '{')
		{
			return ReadObject(out, depth);
		}
		if (c == '[')
		{
			return ReadArray(out, depth);
		}
		if (c == '"')
		{
			out = Value::Text(std::string());
			return ReadString(out.text);
		}
		if (Word("true"))
		{
			out = Value::Boolean(true);
			return true;
		}
		if (Word("false"))
		{
			out = Value::Boolean(false);
			return true;
		}
		if (Word("null"))
		{
			out = Value();
			return true;
		}
		if (c == '-' || (c >= '0' && c <= '9'))
		{
			const size_t start = I;
			++I;
			while (I < S.size() && std::string("0123456789+-.eE").find(S[I]) != std::string::npos)
			{
				++I;
			}
			bool ok = false;
			const double n = ParseDouble(S.substr(start, I - start), ok);
			if (!ok)
			{
				return Fail("bad number");
			}
			out = Value::Number(n);
			return true;
		}
		return Fail("unexpected character");
	}

	bool ReadObject(Value& out, int depth)
	{
		out = Value::Object();
		++I;
		SkipSpace();
		if (I < S.size() && S[I] == '}')
		{
			++I;
			return true;
		}
		for (;;)
		{
			SkipSpace();
			if (I >= S.size() || S[I] != '"')
			{
				return Fail("expected a key");
			}
			std::string key;
			if (!ReadString(key))
			{
				return false;
			}
			SkipSpace();
			if (I >= S.size() || S[I] != ':')
			{
				return Fail("expected ':'");
			}
			++I;
			SkipSpace();
			Value item;
			if (!ReadValue(item, depth + 1))
			{
				return false;
			}
			out.Set(key, std::move(item));
			SkipSpace();
			if (I >= S.size())
			{
				return Fail("unexpected end");
			}
			if (S[I] == ',')
			{
				++I;
				continue;
			}
			if (S[I] == '}')
			{
				++I;
				return true;
			}
			return Fail("expected ',' or '}'");
		}
	}

	bool ReadArray(Value& out, int depth)
	{
		out = Value::Array();
		++I;
		SkipSpace();
		if (I < S.size() && S[I] == ']')
		{
			++I;
			return true;
		}
		for (;;)
		{
			SkipSpace();
			Value item;
			if (!ReadValue(item, depth + 1))
			{
				return false;
			}
			out.items.push_back(std::move(item));
			SkipSpace();
			if (I >= S.size())
			{
				return Fail("unexpected end");
			}
			if (S[I] == ',')
			{
				++I;
				continue;
			}
			if (S[I] == ']')
			{
				++I;
				return true;
			}
			return Fail("expected ',' or ']'");
		}
	}

	bool Hex4(uint32_t& code)
	{
		if (I + 4 > S.size())
		{
			return Fail("short \\u escape");
		}
		code = 0;
		for (int k = 0; k < 4; ++k)
		{
			const char h = S[I++];
			code <<= 4;
			if (h >= '0' && h <= '9')
			{
				code |= static_cast<uint32_t>(h - '0');
			}
			else if (h >= 'a' && h <= 'f')
			{
				code |= static_cast<uint32_t>(h - 'a' + 10);
			}
			else if (h >= 'A' && h <= 'F')
			{
				code |= static_cast<uint32_t>(h - 'A' + 10);
			}
			else
			{
				return Fail("bad \\u escape");
			}
		}
		return true;
	}

	bool ReadString(std::string& out)
	{
		++I;
		for (;;)
		{
			if (I >= S.size())
			{
				return Fail("unterminated string");
			}
			const char c = S[I++];
			if (c == '"')
			{
				return true;
			}
			if (static_cast<unsigned char>(c) < 0x20)
			{
				return Fail("control character in string");
			}
			if (c != '\\')
			{
				out.push_back(c);
				continue;
			}
			if (I >= S.size())
			{
				return Fail("unterminated escape");
			}
			const char e = S[I++];
			switch (e)
			{
			case '"': out.push_back('"'); break;
			case '\\': out.push_back('\\'); break;
			case '/': out.push_back('/'); break;
			case 'b': out.push_back('\b'); break;
			case 'f': out.push_back('\f'); break;
			case 'n': out.push_back('\n'); break;
			case 'r': out.push_back('\r'); break;
			case 't': out.push_back('\t'); break;
			case 'u':
			{
				uint32_t code = 0;
				if (!Hex4(code))
				{
					return false;
				}
				if (code >= 0xD800 && code < 0xDC00 && I + 6 <= S.size() && S[I] == '\\' && S[I + 1] == 'u')
				{
					I += 2;
					uint32_t low = 0;
					if (!Hex4(low))
					{
						return false;
					}
					code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
				}
				AppendUtf8(out, code);
				break;
			}
			default: return Fail("bad escape");
			}
		}
	}
};

inline void WriteString(std::string& out, const std::string& s)
{
	out.push_back('"');
	for (const char c : s)
	{
		switch (c)
		{
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if (static_cast<unsigned char>(c) < 0x20)
			{
				char buf[8];
				std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
				out += buf;
			}
			else
			{
				out.push_back(c);
			}
		}
	}
	out.push_back('"');
}
} // namespace json_detail

inline bool ParseJson(const std::string& text, Value& out, std::string& error)
{
	json_detail::Reader reader(text);
	return reader.Parse(out, error);
}

inline void WriteJson(std::string& out, const Value& v)
{
	switch (v.kind)
	{
	case Value::Kind::Null: out += "null"; break;
	case Value::Kind::Bool: out += v.flag ? "true" : "false"; break;
	case Value::Kind::Number:
	{
		if (!std::isfinite(v.number))
		{
			out += "null";
			break;
		}
		char buf[40];
		std::snprintf(buf, sizeof(buf), "%.17g", v.number);
		out += buf;
		break;
	}
	case Value::Kind::String: json_detail::WriteString(out, v.text); break;
	case Value::Kind::Array:
		out.push_back('[');
		for (size_t i = 0; i < v.items.size(); ++i)
		{
			if (i > 0)
			{
				out.push_back(',');
			}
			WriteJson(out, v.items[i]);
		}
		out.push_back(']');
		break;
	case Value::Kind::Object:
		out.push_back('{');
		for (size_t i = 0; i < v.items.size(); ++i)
		{
			if (i > 0)
			{
				out.push_back(',');
			}
			json_detail::WriteString(out, v.keys[i]);
			out.push_back(':');
			WriteJson(out, v.items[i]);
		}
		out.push_back('}');
		break;
	}
}

inline std::string ToJson(const Value& v)
{
	std::string out;
	WriteJson(out, v);
	return out;
}

// ---- Text ---------------------------------------------------------------------------------------

// Mirrors formatNumber() in packages/rules-core/src/format.ts.
inline std::string FormatNumber(double x)
{
	if (std::isnan(x))
	{
		return "nan";
	}
	if (std::isinf(x))
	{
		return x > 0.0 ? "inf" : "-inf";
	}
	if (x == std::floor(x) && std::fabs(x) < 1e15)
	{
		return std::to_string(static_cast<long long>(x));
	}
	// Two steps on purpose: a fused multiply-add would round x * 100 + 0.5 once instead of twice and
	// could print a different last digit from JavaScript and GDScript.
	volatile double scaled = x * 100.0;
	const double cents = std::floor(scaled + 0.5);
	const bool negative = cents < 0.0;
	const double magnitude = std::fabs(cents);
	const double whole = std::floor(magnitude / 100.0);
	const int frac = static_cast<int>(magnitude - whole * 100.0);
	std::string out;
	if (whole < 9e15)
	{
		out = std::to_string(static_cast<long long>(whole));
	}
	else
	{
		char buf[64];
		std::snprintf(buf, sizeof(buf), "%.0f", whole);
		out = buf;
	}
	if (frac != 0)
	{
		char digits[4];
		std::snprintf(digits, sizeof(digits), "%02d", frac);
		if (digits[1] == '0')
		{
			digits[1] = '\0';
		}
		out += ".";
		out += digits;
	}
	return (negative && magnitude != 0.0 ? "-" : "") + out;
}

inline std::string ToText(const Value& v)
{
	switch (v.kind)
	{
	case Value::Kind::Number: return FormatNumber(v.number);
	case Value::Kind::Bool: return v.flag ? "true" : "false";
	case Value::Kind::String: return v.text;
	default: return std::string();
	}
}

// ---- Runtime ------------------------------------------------------------------------------------

// What a game offers its rules. Arguments and answers are numbers, true/false or text.
class Host
{
public:
	virtual ~Host() = default;
	// Actions with side effects. Set Result to an object of named results, or leave it null.
	// Return false with Error set when the action cannot run.
	virtual bool Call(const std::string& Fn, const Value& Args, Value& Result, std::string& Error) = 0;
	// Pure reads of game state. Return false with Error set when the question cannot be answered.
	virtual bool Query(const std::string& Fn, const Value& Args, Value& Answer, std::string& Error) = 0;
};

struct RunResult
{
	bool handled = false;
	bool halted = false;
	std::vector<std::string> trace;
	std::vector<std::string> logs;
	int statements = 0;
	bool failed = false;
	std::string error;
	std::string errorNode;
};

class RulesVM
{
public:
	static constexpr int IrVersion = 1;
	static constexpr int MaxStatements = 20000;
	static constexpr int MaxRepeat = 1000;

	Value program;
	Value variables = Value::Object();

	// Returns "" on success or an error message.
	std::string Load(const Value& p)
	{
		const Value& version = p.Get("irVersion");
		if (!version.IsNumber() || version.number != IrVersion)
		{
			return "Unsupported rule program version: " + (version.IsNull() ? std::string("missing") : ToText(version));
		}
		if (!p.Get("handlers").IsObject() || !p.Get("variables").IsObject())
		{
			return "Rule program is missing handlers or variables";
		}
		program = p;
		Reset();
		return std::string();
	}

	void Reset()
	{
		variables = Value::Object();
		const Value& decls = program.Get("variables");
		for (size_t i = 0; i < decls.Size(); ++i)
		{
			variables.Set(decls.keys[i], decls.items[i].Get("initial"));
		}
	}

	// Restores saved values; names the program does not declare are ignored.
	void SetVariables(const Value& values)
	{
		const Value& decls = program.Get("variables");
		for (size_t i = 0; i < values.Size() && values.IsObject(); ++i)
		{
			if (decls.Has(values.keys[i]))
			{
				variables.Set(values.keys[i], values.items[i]);
			}
		}
	}

	std::string GraphId() const { return program.Str("graphId"); }
	bool HasHandler(const std::string& Event) const { return program.Get("handlers").Has(Event); }

	RunResult Run(const std::string& Event, const Value& Payload, Host* RuleHost, int Limit = MaxStatements)
	{
		RunResult r;
		const Value* handler = program.Get("handlers").Find(Event);
		if (!handler)
		{
			return r;
		}
		r.handled = true;
		payload = Payload.IsObject() ? Payload : Value::Object();
		host = RuleHost;
		temps = Value::Object();
		result = &r;
		current.clear();
		eventName = Event;
		maxStatements = Limit;
		halted = false;
		ExecBlock(handler->Get("body"));
		r.halted = halted && !r.failed;
		result = nullptr;
		host = nullptr;
		return r;
	}

private:
	Value payload;
	Host* host = nullptr;
	Value temps;
	RunResult* result = nullptr;
	std::string current;
	std::string eventName;
	int maxStatements = MaxStatements;
	bool halted = false;

	void Fail(const std::string& message)
	{
		if (!result->failed)
		{
			result->failed = true;
			result->error = message;
			result->errorNode = current;
		}
	}

	bool Stopped() const { return halted || result->failed; }

	void ExecBlock(const Value& stmts)
	{
		for (size_t i = 0; i < stmts.items.size() && stmts.IsArray(); ++i)
		{
			if (Stopped())
			{
				return;
			}
			const Value& stmt = stmts.items[i];
			result->statements += 1;
			if (result->statements > maxStatements)
			{
				Fail("Stopped after " + std::to_string(maxStatements) + " steps (possible runaway rule)");
				return;
			}
			const std::string node = stmt.Str("node");
			if (!node.empty())
			{
				current = node;
			}
			const std::string kind = stmt.Str("s");
			if (kind == "trace")
			{
				current = node;
				if (result->trace.empty() || result->trace.back() != node)
				{
					result->trace.push_back(node);
				}
			}
			else if (kind == "set")
			{
				ExecSet(stmt);
			}
			else if (kind == "call")
			{
				ExecCall(stmt);
			}
			else if (kind == "if")
			{
				const Value cond = Eval(stmt.Get("cond"));
				if (result->failed)
				{
					return;
				}
				if (!cond.IsBool())
				{
					Fail("Branch condition must be true or false");
					return;
				}
				ExecBlock(stmt.Get(cond.flag ? "then" : "else"));
			}
			else if (kind == "switch")
			{
				const Value value = Eval(stmt.Get("value"));
				if (result->failed)
				{
					return;
				}
				const Value* branch = stmt.Get("cases").Find(ToText(value));
				ExecBlock(branch ? *branch : stmt.Get("default"));
			}
			else if (kind == "repeat")
			{
				const Value n = Eval(stmt.Get("count"));
				if (result->failed)
				{
					return;
				}
				if (!n.IsNumber() || !std::isfinite(n.number))
				{
					Fail("Repeat count must be a number");
					return;
				}
				const double clamped = std::fmax(0.0, std::fmin(static_cast<double>(MaxRepeat), std::floor(n.number)));
				const int times = static_cast<int>(clamped);
				const std::string index = stmt.Str("index");
				for (int k = 0; k < times; ++k)
				{
					Value record = Value::Object();
					record.Set("index", Value::Number(static_cast<double>(k)));
					temps.Set(index, std::move(record));
					ExecBlock(stmt.Get("body"));
					if (Stopped())
					{
						return;
					}
				}
				temps.Erase(index);
			}
			else if (kind == "halt")
			{
				halted = true;
				return;
			}
			else
			{
				Fail("Unknown statement '" + kind + "'");
				return;
			}
		}
	}

	void ExecSet(const Value& stmt)
	{
		const std::string name = stmt.Str("var");
		const Value* decl = program.Get("variables").Find(name);
		if (!decl)
		{
			Fail("Unknown variable '" + name + "'");
			return;
		}
		Value value = Eval(stmt.Get("value"));
		if (result->failed)
		{
			return;
		}
		const std::string type = decl->Str("type");
		if (type == "text")
		{
			value = Value::Text(ToText(value));
		}
		const bool ok = (type == "number" && value.IsNumber()) || (type == "boolean" && value.IsBool()) || (type == "text" && value.IsString());
		if (!ok)
		{
			Fail("Variable '" + name + "' needs " + type);
			return;
		}
		variables.Set(name, std::move(value));
	}

	bool EvalArgs(const Value& source, Value& args)
	{
		args = Value::Object();
		for (size_t i = 0; i < source.Size() && source.IsObject(); ++i)
		{
			Value v = Eval(source.items[i]);
			if (result->failed)
			{
				return false;
			}
			args.Set(source.keys[i], std::move(v));
		}
		return true;
	}

	void ExecCall(const Value& stmt)
	{
		Value args;
		if (!EvalArgs(stmt.Get("args"), args))
		{
			return;
		}
		const std::string fn = stmt.Str("fn");
		const std::string outName = stmt.Str("out");
		if (fn == "core.log")
		{
			result->logs.push_back(ToText(args.Get("message")));
			if (!outName.empty())
			{
				temps.Set(outName, Value::Object());
			}
			return;
		}
		if (!host)
		{
			Fail("No host is connected");
			return;
		}
		Value res;
		std::string problem;
		if (!host->Call(fn, args, res, problem))
		{
			Fail(problem);
			return;
		}
		if (!outName.empty())
		{
			temps.Set(outName, res.IsObject() ? res : Value::Object());
		}
	}

	Value Eval(const Value& expr)
	{
		if (result->failed)
		{
			return Value();
		}
		const std::string kind = expr.Str("e");
		if (kind == "const")
		{
			return expr.Get("v");
		}
		if (kind == "var")
		{
			const std::string name = expr.Str("name");
			const Value* v = variables.Find(name);
			if (!v)
			{
				Fail("Unknown variable '" + name + "'");
				return Value();
			}
			return *v;
		}
		if (kind == "param")
		{
			const std::string name = expr.Str("name");
			const Value* v = payload.Find(name);
			if (!v || v->IsNull())
			{
				Fail("Event '" + eventName + "' is missing '" + name + "'");
				return Value();
			}
			return *v;
		}
		if (kind == "temp")
		{
			const std::string field = expr.Str("field");
			const Value* record = temps.Find(expr.Str("name"));
			const Value* v = record ? record->Find(field) : nullptr;
			if (!v)
			{
				Fail("Value '" + field + "' is not available yet");
				return Value();
			}
			return *v;
		}
		if (kind == "op")
		{
			const std::string op = expr.Str("op");
			const Value& raw = expr.Get("args");
			const int arity = Arity(op);
			if (arity == 0 || !raw.IsArray() || raw.items.size() != static_cast<size_t>(arity))
			{
				Fail("Operator '" + op + "' has the wrong number of inputs");
				return Value();
			}
			std::vector<Value> values;
			for (const Value& a : raw.items)
			{
				values.push_back(Eval(a));
				if (result->failed)
				{
					return Value();
				}
			}
			return ApplyOp(op, values);
		}
		if (kind == "query")
		{
			Value args;
			if (!EvalArgs(expr.Get("args"), args))
			{
				return Value();
			}
			const std::string fn = expr.Str("fn");
			if (!host)
			{
				Fail("No host is connected");
				return Value();
			}
			Value answer;
			std::string problem;
			if (!host->Query(fn, args, answer, problem))
			{
				Fail(problem);
				return Value();
			}
			if (answer.IsNull())
			{
				Fail("Query '" + fn + "' returned no value");
				return Value();
			}
			return answer;
		}
		Fail("Unknown expression '" + kind + "'");
		return Value();
	}

	static int Arity(const std::string& op)
	{
		static const char* const Two[] = {"add", "sub", "mul", "div", "idiv", "mod", "min", "max", "eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "concat"};
		static const char* const One[] = {"neg", "abs", "floor", "ceil", "round", "not", "text"};
		for (const char* name : Two)
		{
			if (op == name)
			{
				return 2;
			}
		}
		for (const char* name : One)
		{
			if (op == name)
			{
				return 1;
			}
		}
		return 0;
	}

	static const char* TypeName(const Value& v)
	{
		return v.IsNumber() ? "number" : v.IsBool() ? "boolean" : v.IsString() ? "string" : "nothing";
	}

	double Num(const Value& v, const std::string& op)
	{
		if (!v.IsNumber() || std::isnan(v.number))
		{
			Fail("Operator '" + op + "' expects a number, received " + TypeName(v));
			return 0.0;
		}
		return v.number;
	}

	bool Bool(const Value& v, const std::string& op)
	{
		if (!v.IsBool())
		{
			Fail("Operator '" + op + "' expects true/false, received " + TypeName(v));
			return false;
		}
		return v.flag;
	}

	static bool Same(const Value& a, const Value& b)
	{
		if (a.kind != b.kind)
		{
			return false;
		}
		switch (a.kind)
		{
		case Value::Kind::Number: return a.number == b.number;
		case Value::Kind::Bool: return a.flag == b.flag;
		case Value::Kind::String: return a.text == b.text;
		default: return false;
		}
	}

	Value ApplyOp(const std::string& op, const std::vector<Value>& args)
	{
		const Value& a = args[0];
		static const Value None;
		const Value& b = args.size() > 1 ? args[1] : None;
		// Both inputs are checked before the result is used, as in the GDScript runtime; a failed
		// check has already recorded the error, so the value returned here is never seen.
		if (op == "add") { const double x = Num(a, op); const double y = Num(b, op); return Value::Number(x + y); }
		if (op == "sub") { const double x = Num(a, op); const double y = Num(b, op); return Value::Number(x - y); }
		if (op == "mul") { const double x = Num(a, op); const double y = Num(b, op); return Value::Number(x * y); }
		if (op == "div" || op == "idiv" || op == "mod")
		{
			const double d = Num(b, op);
			const double n = Num(a, op);
			if (result->failed)
			{
				return Value();
			}
			if (d == 0.0)
			{
				Fail(op == "mod" ? "Modulo by zero" : "Division by zero");
				return Value();
			}
			if (op == "div")
			{
				return Value::Number(n / d);
			}
			if (op == "idiv")
			{
				return Value::Number(std::floor(n / d));
			}
			return Value::Number(std::fmod(std::fmod(n, d) + d, d));
		}
		if (op == "min") { const double x = Num(a, op); const double y = Num(b, op); return Value::Number(std::fmin(x, y)); }
		if (op == "max") { const double x = Num(a, op); const double y = Num(b, op); return Value::Number(std::fmax(x, y)); }
		if (op == "neg") return Value::Number(-Num(a, op));
		if (op == "abs") return Value::Number(std::fabs(Num(a, op)));
		if (op == "floor") return Value::Number(std::floor(Num(a, op)));
		if (op == "ceil") return Value::Number(std::ceil(Num(a, op)));
		if (op == "round") return Value::Number(std::floor(Num(a, op) + 0.5));
		if (op == "eq") return Value::Boolean(Same(a, b));
		if (op == "neq") return Value::Boolean(!Same(a, b));
		if (op == "lt") { const double x = Num(a, op); const double y = Num(b, op); return Value::Boolean(x < y); }
		if (op == "lte") { const double x = Num(a, op); const double y = Num(b, op); return Value::Boolean(x <= y); }
		if (op == "gt") { const double x = Num(a, op); const double y = Num(b, op); return Value::Boolean(x > y); }
		if (op == "gte") { const double x = Num(a, op); const double y = Num(b, op); return Value::Boolean(x >= y); }
		if (op == "and") { const bool x = Bool(a, op); const bool y = Bool(b, op); return Value::Boolean(x && y); }
		if (op == "or") { const bool x = Bool(a, op); const bool y = Bool(b, op); return Value::Boolean(x || y); }
		if (op == "not") return Value::Boolean(!Bool(a, op));
		if (op == "text") return Value::Text(ToText(a));
		if (op == "concat") return Value::Text(ToText(a) + ToText(b));
		Fail("Unknown operator '" + op + "'");
		return Value();
	}
};

} // namespace gsrules
