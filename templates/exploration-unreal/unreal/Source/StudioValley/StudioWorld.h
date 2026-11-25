#pragma once

#include "CoreMinimal.h"

// One object from the level layout edited in Game Studio (data/world.json). Fields a type does
// not use keep their defaults.
struct FStudioObject
{
	FString Id;
	FString Type;
	FString Variant;
	FString Label;
	FString Name;
	FString Color;
	/** Collectible kind (rules count by kind) and sign text. */
	FString Kind = TEXT("crystal");
	FString Text;
	double X = 0.0;
	double Z = 0.0;
	double Rotation = 0.0;
	double Scale = 1.0;
	double Width = 5.0;
	double Radius = 3.0;
	bool bVisible = true;
};

struct FStudioWorld
{
	FString Name;
	double Width = 60.0;
	double Depth = 60.0;
	FString SkyHorizon = TEXT("#b8d4ec");
	FString Ground = TEXT("#5a7d3c");
	double SunElevation = 48.0;
	double SunHeading = 35.0;
	double FogDensity = 0.0;
	FString SunColor = TEXT("#ffffff");
	double SpawnX = 0.0;
	double SpawnZ = 0.0;
	double Speed = 6.0;
	double SprintMultiplier = 1.7;
	double JumpVelocity = 5.5;
	double CameraDistance = 6.0;
	TArray<FStudioObject> Objects;

	/** The studio copies the layout to Content/GameStudioData/world.json; packaging stages it as a loose file. */
	static FString Path();
	static bool Load(FStudioWorld& Out, FString& Error);

	/**
	 * Game Studio and Godot use metres with x east and z south (north is -z). Unreal uses centimetres
	 * with X forward (north), Y right (east) and Z up, so the layout keeps its orientation.
	 */
	static FVector ToUnreal(double X, double Z, double Up = 0.0) { return FVector(-Z * 100.0, X * 100.0, Up * 100.0); }

	static FLinearColor ParseColor(const FString& Hex, const FLinearColor& Fallback);
};
