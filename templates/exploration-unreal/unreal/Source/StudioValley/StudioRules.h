#pragma once

#include "CoreMinimal.h"
#include "StudioRulesVM.h"

#include <vector>

class AStudioGameMode;

// Loads the rule programs Game Studio compiles into Content/GameStudioData and runs them against the
// level. Mirrors main.gd and explore_host.gd in the Godot template, and ExploreSimHost in the studio's
// simulator, so a level plays the same in every engine. The interpreter is StudioRulesVM.h (shared
// with engine-addons/unreal and checked against the conformance fixtures outside Unreal).
class FStudioRules : public gsrules::Host
{
public:
	struct FProgram
	{
		FString Id;
		gsrules::RulesVM Vm;
	};

	FStudioRules(AStudioGameMode& InGame, bool bInTelemetry);

	void Load();
	/** Sends a game event to every rule program that handles it. */
	void Fire(const FString& Event, const gsrules::Value& Payload);
	/** Prints one GSTUDIO line (JSON) for Game Studio's run console when -studio-telemetry is set. */
	void Emit(const gsrules::Value& Data) const;
	bool Handles(const FString& Event) const;
	int32 RunsOf(const FString& Event) const { return Runs.FindRef(Event); }

	virtual bool Call(const std::string& Fn, const gsrules::Value& Args, gsrules::Value& Result, std::string& Error) override;
	virtual bool Query(const std::string& Fn, const gsrules::Value& Args, gsrules::Value& Answer, std::string& Error) override;

	std::vector<FProgram> Programs;
	TArray<FString> Errors;

	static std::string Utf8(const FString& Text);
	static FString FromUtf8(const std::string& Text);

private:
	void Problem(const FString& Message);

	AStudioGameMode& Game;
	bool bTelemetry = false;
	TMap<FString, int32> Runs;
};
