#include "StudioRules.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "StudioGameMode.h"
#include "StudioValley.h"
#include <stdio.h>

std::string FStudioRules::Utf8(const FString& Text)
{
	const FTCHARToUTF8 Converted(*Text);
	return std::string(Converted.Get(), static_cast<size_t>(Converted.Length()));
}

FString FStudioRules::FromUtf8(const std::string& Text)
{
	return FString(UTF8_TO_TCHAR(Text.c_str()));
}

FStudioRules::FStudioRules(AStudioGameMode& InGame, bool bInTelemetry) : Game(InGame), bTelemetry(bInTelemetry) {}

static bool ReadUtf8File(const FString& Path, std::string& Out)
{
	TArray<uint8> Bytes;
	if (!FPaths::FileExists(Path) || !FFileHelper::LoadFileToArray(Bytes, *Path))
	{
		return false;
	}
	Out.assign(reinterpret_cast<const char*>(Bytes.GetData()), static_cast<size_t>(Bytes.Num()));
	return true;
}

// Rule files are named <id>.ir.json with lower-case letters, digits and dashes, as in main.gd.
static bool IsRuleFileName(const std::string& Name)
{
	const std::string Suffix = ".ir.json";
	if (Name.size() <= Suffix.size() || Name.compare(Name.size() - Suffix.size(), Suffix.size(), Suffix) != 0)
	{
		return false;
	}
	for (size_t i = 0; i < Name.size() - Suffix.size(); ++i)
	{
		const char C = Name[i];
		const bool bOk = (C >= 'a' && C <= 'z') || (C >= '0' && C <= '9') || (C == '-' && i > 0);
		if (!bOk)
		{
			return false;
		}
	}
	return true;
}

void FStudioRules::Problem(const FString& Message)
{
	Errors.Add(Message);
	UE_LOG(LogStudio, Warning, TEXT("Game rules: %s"), *Message);
}

void FStudioRules::Load()
{
	const FString Dir = FPaths::Combine(FPaths::ProjectContentDir(), TEXT("GameStudioData"));
	std::string Text;
	if (!ReadUtf8File(FPaths::Combine(Dir, TEXT("rules_index.json")), Text))
	{
		Problem(TEXT("No compiled rules found. Save the project in Game Studio to compile them."));
		return;
	}
	gsrules::Value Index;
	std::string ParseError;
	if (!gsrules::ParseJson(Text, Index, ParseError) || !Index.IsObject())
	{
		Problem(TEXT("rules_index.json is not valid JSON"));
		return;
	}
	for (const gsrules::Value& Entry : Index.Get("programs").items)
	{
		const std::string File = Entry.IsString() ? Entry.text : std::string();
		if (!IsRuleFileName(File))
		{
			Problem(FString::Printf(TEXT("Ignored rule file with an unexpected name: %s"), *FromUtf8(File)));
			continue;
		}
		const FString Path = FPaths::Combine(Dir, TEXT("rules"), FromUtf8(File));
		gsrules::Value Parsed;
		if (!ReadUtf8File(Path, Text) || !gsrules::ParseJson(Text, Parsed, ParseError))
		{
			Problem(FString::Printf(TEXT("Cannot read %s"), *Path));
			continue;
		}
		FProgram Program;
		const std::string LoadError = Program.Vm.Load(Parsed);
		if (!LoadError.empty())
		{
			Problem(FString::Printf(TEXT("%s: %s"), *FromUtf8(File), *FromUtf8(LoadError)));
			continue;
		}
		const std::string GraphId = Program.Vm.GraphId();
		Program.Id = FromUtf8(GraphId.empty() ? File : GraphId);
		Programs.push_back(std::move(Program));
	}
	UE_LOG(LogStudio, Display, TEXT("Loaded %d rule program(s)"), static_cast<int32>(Programs.size()));
}

bool FStudioRules::Handles(const FString& Event) const
{
	const std::string Name = Utf8(Event);
	for (const FProgram& Program : Programs)
	{
		if (Program.Vm.HasHandler(Name))
		{
			return true;
		}
	}
	return false;
}

static gsrules::Value Strings(const std::vector<std::string>& List)
{
	gsrules::Value Out = gsrules::Value::Array();
	for (const std::string& S : List)
	{
		Out.items.push_back(gsrules::Value::Text(S));
	}
	return Out;
}

void FStudioRules::Fire(const FString& Event, const gsrules::Value& Payload)
{
	const std::string Name = Utf8(Event);
	for (FProgram& Program : Programs)
	{
		if (!Program.Vm.HasHandler(Name))
		{
			continue;
		}
		const gsrules::RunResult R = Program.Vm.Run(Name, Payload, this);
		Runs.FindOrAdd(Event) += 1;
		if (R.failed)
		{
			Problem(FString::Printf(TEXT("Rule error in %s: %s"), *Program.Id, *FromUtf8(R.error)));
		}
		for (const std::string& Line : R.logs)
		{
			UE_LOG(LogStudio, Display, TEXT("[rules] %s"), *FromUtf8(Line));
		}
		if (bTelemetry)
		{
			gsrules::Value Data = gsrules::Value::Object();
			Data.Set("type", gsrules::Value::Text("rule"));
			Data.Set("program", gsrules::Value::Text(Utf8(Program.Id)));
			Data.Set("event", gsrules::Value::Text(Name));
			Data.Set("payload", Payload);
			Data.Set("trace", Strings(R.trace));
			Data.Set("logs", Strings(R.logs));
			Data.Set("error", R.failed ? gsrules::Value::Text(R.error) : gsrules::Value());
			Data.Set("errorNode", R.failed && !R.errorNode.empty() ? gsrules::Value::Text(R.errorNode) : gsrules::Value());
			Data.Set("halted", gsrules::Value::Boolean(R.halted));
			Emit(Data);
		}
	}
}

void FStudioRules::Emit(const gsrules::Value& Data) const
{
	if (!bTelemetry)
	{
		return;
	}
	// Plain stdout, so the line starts with GSTUDIO (log lines carry a timestamp prefix).
	const std::string Line = "GSTUDIO " + gsrules::ToJson(Data) + "\n";
	fwrite(Line.data(), 1, Line.size(), stdout);
	fflush(stdout);
}

bool FStudioRules::Call(const std::string& Fn, const gsrules::Value& Args, gsrules::Value& Result, std::string& Error)
{
	(void)Result;
	const auto Text = [&Args](const char* Key) { return FromUtf8(gsrules::ToText(Args.Get(Key))); };
	if (Fn == "explore.message")
	{
		const gsrules::Value& Seconds = Args.Get("seconds");
		Game.ShowMessage(Text("text"), Seconds.IsNumber() ? static_cast<float>(Seconds.number) : 4.f);
		return true;
	}
	if (Fn == "explore.objective")
	{
		Game.Objective = Text("text");
		return true;
	}
	if (Fn == "explore.openGate")
	{
		const FString Id = Text("gateId");
		if (!Game.OpenGate(Id))
		{
			Error = "There is no gate '" + Utf8(Id) + "' in this level";
			return false;
		}
		return true;
	}
	if (Fn == "explore.sound")
	{
		Game.PlayCue(Text("sound"));
		return true;
	}
	if (Fn == "explore.setVisible")
	{
		const FString Id = Text("objectId");
		const gsrules::Value& Visible = Args.Get("visible");
		if (!Game.SetObjectVisible(Id, Visible.IsBool() && Visible.flag))
		{
			Error = "There is no object '" + Utf8(Id) + "' in this level";
			return false;
		}
		return true;
	}
	if (Fn == "explore.win")
	{
		Game.ShowWin(Text("text"));
		return true;
	}
	Error = "Unknown exploration action '" + Fn + "'";
	return false;
}

bool FStudioRules::Query(const std::string& Fn, const gsrules::Value& Args, gsrules::Value& Answer, std::string& Error)
{
	const FString Arg = FromUtf8(gsrules::ToText(Args.Get(Fn == "explore.isGateOpen" ? "gateId" : "kind")));
	if (Fn == "explore.collectedCount")
	{
		Answer = gsrules::Value::Number(Game.CollectedCount(Arg));
		return true;
	}
	if (Fn == "explore.totalCount")
	{
		Answer = gsrules::Value::Number(Game.TotalCount(Arg));
		return true;
	}
	if (Fn == "explore.isGateOpen")
	{
		Answer = gsrules::Value::Boolean(Game.IsGateOpen(Arg));
		return true;
	}
	Error = "Unknown exploration query '" + Fn + "'";
	return false;
}
