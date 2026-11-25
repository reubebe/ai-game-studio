// Runs packages/rules-core/src/conformance/fixtures.json against the C++ rule runtime.
// Mirrors engine-addons/godot/gamestudio_runtime/tests/run_conformance.gd. Exit code 0 when every step
// matches the TypeScript runtime's recorded results. Built and run by packages/rules-core/src/runtimes.test.ts
// with -fno-exceptions -fno-rtti and warnings as errors, close to how Unreal compiles the module.
#include "../StudioRules/StudioRulesVM.h"

#include <fstream>
#include <iostream>
#include <sstream>

using gsrules::Value;

namespace
{
class ScriptedHost : public gsrules::Host
{
public:
	Value calls = Value::Array();

	ScriptedHost(const Value& InQueries, const Value& InResults) : queries(InQueries), results(InResults) {}

	bool Call(const std::string& Fn, const Value& Args, Value& Result, std::string& Error) override
	{
		(void)Error;
		Value entry = Value::Object();
		entry.Set("fn", Value::Text(Fn));
		entry.Set("args", Args);
		calls.items.push_back(entry);
		if (const Value* r = results.Find(Fn))
		{
			Result = *r;
		}
		return true;
	}

	bool Query(const std::string& Fn, const Value& Args, Value& Answer, std::string& Error) override
	{
		const Value* answer = queries.Find(Fn);
		if (!answer)
		{
			Error = "No scripted answer for '" + Fn + "'";
			return false;
		}
		if (answer->IsObject())
		{
			const std::string key = gsrules::ToText(Args.Get(answer->Str("by")));
			const Value* found = answer->Get("values").Find(key);
			Answer = found ? *found : answer->Get("default");
			return true;
		}
		Answer = *answer;
		return true;
	}

private:
	const Value& queries;
	const Value& results;
};

bool DeepEqual(const Value& a, const Value& b)
{
	if (a.kind != b.kind)
	{
		return false;
	}
	switch (a.kind)
	{
	case Value::Kind::Null: return true;
	case Value::Kind::Bool: return a.flag == b.flag;
	case Value::Kind::Number: return a.number == b.number;
	case Value::Kind::String: return a.text == b.text;
	case Value::Kind::Array:
		if (a.items.size() != b.items.size())
		{
			return false;
		}
		for (size_t i = 0; i < a.items.size(); ++i)
		{
			if (!DeepEqual(a.items[i], b.items[i]))
			{
				return false;
			}
		}
		return true;
	case Value::Kind::Object:
		if (a.Size() != b.Size())
		{
			return false;
		}
		for (size_t i = 0; i < a.Size(); ++i)
		{
			const Value* other = b.Find(a.keys[i]);
			if (!other || !DeepEqual(a.items[i], *other))
			{
				return false;
			}
		}
		return true;
	}
	return false;
}

Value Strings(const std::vector<std::string>& list)
{
	Value out = Value::Array();
	for (const std::string& s : list)
	{
		out.items.push_back(Value::Text(s));
	}
	return out;
}

int FormatChecks()
{
	// Shared with packages/rules-core/src/format.test.ts.
	const struct
	{
		double in;
		const char* out;
	} cases[] = {{3.0, "3"}, {-0.0, "0"}, {2.5, "2.5"}, {1.0 / 3.0, "0.33"}, {2.675, "2.68"}, {-1.005, "-1"}, {0.1 + 0.2, "0.3"}, {-2.5, "-2.5"}, {1e15, "1000000000000000"}, {0.004, "0"}, {-0.004, "0"}, {1.005, "1"}, {8.345, "8.35"}, {0.125, "0.13"}, {-0.125, "-0.12"}, {2.999, "3"}, {-2.0, "-2"}};
	int failures = 0;
	for (const auto& c : cases)
	{
		const std::string got = gsrules::FormatNumber(c.in);
		if (got != c.out)
		{
			std::cout << "FAIL format " << c.in << ": expected " << c.out << ", got " << got << "\n";
			++failures;
		}
	}
	return failures;
}
} // namespace

int main(int argc, char** argv)
{
	if (argc < 2)
	{
		std::cout << "usage: conformance <fixtures.json>\n";
		return 2;
	}
	std::ifstream file(argv[1], std::ios::binary);
	std::stringstream buffer;
	buffer << file.rdbuf();
	Value data;
	std::string parseError;
	if (!gsrules::ParseJson(buffer.str(), data, parseError))
	{
		std::cout << "GSTUDIO_CONFORMANCE FAIL cannot read fixtures: " << parseError << "\n";
		return 2;
	}
	int failures = FormatChecks();
	int steps = 0;
	for (const Value& scenario : data.Get("scenarios").items)
	{
		gsrules::RulesVM vm;
		const std::string loadError = vm.Load(scenario.Get("program"));
		if (!loadError.empty())
		{
			std::cout << "FAIL " << scenario.Str("name") << ": " << loadError << "\n";
			++failures;
			continue;
		}
		int index = 0;
		for (const Value& step : scenario.Get("steps").items)
		{
			++index;
			++steps;
			ScriptedHost host(scenario.Get("queries"), scenario.Get("results"));
			const gsrules::RunResult r = vm.Run(step.Str("event"), step.Get("payload"), &host);
			Value actual = Value::Object();
			actual.Set("handled", Value::Boolean(r.handled));
			actual.Set("halted", Value::Boolean(r.halted));
			actual.Set("error", Value::Boolean(r.failed));
			actual.Set("errorNode", r.failed && !r.errorNode.empty() ? Value::Text(r.errorNode) : Value());
			actual.Set("variables", vm.variables);
			actual.Set("calls", host.calls);
			actual.Set("logs", Strings(r.logs));
			actual.Set("trace", Strings(r.trace));
			const Value& expect = step.Get("expect");
			for (size_t i = 0; i < expect.Size(); ++i)
			{
				const Value& got = actual.Get(expect.keys[i]);
				if (DeepEqual(expect.items[i], got))
				{
					continue;
				}
				++failures;
				std::cout << "FAIL " << scenario.Str("name") << " step " << index << " (" << expect.keys[i] << "): expected " << gsrules::ToJson(expect.items[i]) << ", got " << gsrules::ToJson(got) << "\n";
			}
		}
	}
	if (failures == 0)
	{
		std::cout << "GSTUDIO_CONFORMANCE PASS " << steps << " steps\n";
		return 0;
	}
	std::cout << "GSTUDIO_CONFORMANCE FAIL " << failures << " mismatches in " << steps << " steps\n";
	return 1;
}
