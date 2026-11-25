#include "StudioWorld.h"
#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FString FStudioWorld::Path()
{
	return FPaths::Combine(FPaths::ProjectContentDir(), TEXT("GameStudioData"), TEXT("world.json"));
}

static double Number(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, double Fallback)
{
	double Value = Fallback;
	return Object.IsValid() && Object->TryGetNumberField(Field, Value) ? Value : Fallback;
}

static FString Text(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, const FString& Fallback = FString())
{
	FString Value;
	return Object.IsValid() && Object->TryGetStringField(Field, Value) ? Value : Fallback;
}

static TSharedPtr<FJsonObject> Child(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field)
{
	const TSharedPtr<FJsonObject>* Found = nullptr;
	return Object.IsValid() && Object->TryGetObjectField(Field, Found) && Found ? *Found : TSharedPtr<FJsonObject>();
}

bool FStudioWorld::Load(FStudioWorld& Out, FString& Error)
{
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *Path()))
	{
		Error = FString::Printf(TEXT("Missing %s"), *Path());
		return false;
	}
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid() || Text(Root, TEXT("kind")) != TEXT("explore-world"))
	{
		Error = TEXT("world.json is not an exploration world");
		return false;
	}
	Out.Name = Text(Root, TEXT("name"), TEXT("Untitled"));
	const TSharedPtr<FJsonObject> Size = Child(Root, TEXT("size"));
	Out.Width = Number(Size, TEXT("width"), Out.Width);
	Out.Depth = Number(Size, TEXT("depth"), Out.Depth);
	const TSharedPtr<FJsonObject> Env = Child(Root, TEXT("environment"));
	Out.SkyHorizon = Text(Env, TEXT("skyHorizon"), Out.SkyHorizon);
	Out.Ground = Text(Env, TEXT("ground"), Out.Ground);
	Out.SunElevation = Number(Env, TEXT("sunElevation"), Out.SunElevation);
	Out.SunHeading = Number(Env, TEXT("sunHeading"), Out.SunHeading);
	Out.FogDensity = Number(Env, TEXT("fogDensity"), Out.FogDensity);
	Out.SunColor = Text(Env, TEXT("sunColor"), Out.SunColor);
	const TSharedPtr<FJsonObject> Player = Child(Root, TEXT("player"));
	const TSharedPtr<FJsonObject> Spawn = Child(Player, TEXT("spawn"));
	Out.SpawnX = Number(Spawn, TEXT("x"), 0.0);
	Out.SpawnZ = Number(Spawn, TEXT("z"), 0.0);
	Out.Speed = Number(Player, TEXT("speed"), Out.Speed);
	Out.SprintMultiplier = Number(Player, TEXT("sprintMultiplier"), Out.SprintMultiplier);
	Out.JumpVelocity = Number(Player, TEXT("jumpVelocity"), Out.JumpVelocity);
	Out.CameraDistance = Number(Player, TEXT("cameraDistance"), Out.CameraDistance);

	const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
	if (!Root->TryGetArrayField(TEXT("objects"), Items) || !Items)
	{
		Error = TEXT("world.json has no objects list");
		return false;
	}
	for (const TSharedPtr<FJsonValue>& Item : *Items)
	{
		const TSharedPtr<FJsonObject> O = Item.IsValid() ? Item->AsObject() : nullptr;
		if (!O.IsValid())
		{
			continue;
		}
		FStudioObject Obj;
		Obj.Id = Text(O, TEXT("id"));
		Obj.Type = Text(O, TEXT("type"));
		Obj.Variant = Text(O, TEXT("variant"));
		Obj.Label = Text(O, TEXT("label"));
		Obj.Name = Text(O, TEXT("name"));
		Obj.Color = Text(O, TEXT("color"));
		Obj.Kind = Text(O, TEXT("kind"), TEXT("crystal"));
		Obj.Text = Text(O, TEXT("text"));
		Obj.X = Number(O, TEXT("x"), 0.0);
		Obj.Z = Number(O, TEXT("z"), 0.0);
		Obj.Rotation = Number(O, TEXT("rotation"), 0.0);
		Obj.Scale = FMath::Clamp(Number(O, TEXT("scale"), 1.0), 0.2, 5.0);
		Obj.Width = Number(O, TEXT("width"), Obj.Width);
		Obj.Radius = Number(O, TEXT("radius"), Obj.Radius);
		O->TryGetBoolField(TEXT("visible"), Obj.bVisible);
		if (!Obj.Id.IsEmpty())
		{
			Out.Objects.Add(MoveTemp(Obj));
		}
	}
	return true;
}

FLinearColor FStudioWorld::ParseColor(const FString& Hex, const FLinearColor& Fallback)
{
	FString Digits = Hex;
	Digits.RemoveFromStart(TEXT("#"));
	if (Digits.Len() != 6)
	{
		return Fallback;
	}
	for (const TCHAR C : Digits)
	{
		if (!FChar::IsHexDigit(C))
		{
			return Fallback;
		}
	}
	return FLinearColor::FromSRGBColor(FColor::FromHex(Digits));
}
