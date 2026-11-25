#include "StudioHUD.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "StudioGameMode.h"
#include "StudioRules.h"

void AStudioHUD::DrawHUD()
{
	Super::DrawHUD();
	const AStudioGameMode* Game = GetWorld() ? GetWorld()->GetAuthGameMode<AStudioGameMode>() : nullptr;
	if (!Game || !Canvas)
	{
		return;
	}
	UFont* Font = GEngine->GetMediumFont();
	UFont* Large = GEngine->GetLargeFont();
	const float W = static_cast<float>(Canvas->SizeX);
	const float H = static_cast<float>(Canvas->SizeY);

	// Top left: level, objective, progress and any problems.
	TArray<FString> Lines;
	Lines.Add(Game->World.Name.IsEmpty() ? FString(TEXT("No level loaded")) : Game->World.Name);
	if (!Game->Objective.IsEmpty())
	{
		Lines.Add(Game->Objective);
	}
	Lines.Add(FString::Printf(TEXT("Collected %d of %d"), Game->Collected.Num(), Game->CountOfType(TEXT("collectible"))));
	if (!Game->LoadError.IsEmpty())
	{
		Lines.Add(Game->LoadError);
	}
	if (Game->Rules)
	{
		const TArray<FString>& Errors = Game->Rules->Errors;
		for (int32 i = FMath::Max(0, Errors.Num() - 3); i < Errors.Num(); ++i)
		{
			Lines.Add(Errors[i]);
		}
	}
	DrawRect(FLinearColor(0.f, 0.f, 0.f, 0.45f), 16.f, 16.f, 760.f, 24.f + 22.f * Lines.Num());
	float Y = 28.f;
	for (const FString& Line : Lines)
	{
		DrawText(Line, FLinearColor::White, 28.f, Y, Font, 1.f);
		Y += 22.f;
	}

	// Bottom: the current message, then the controls.
	if (!Game->CurrentMessage.IsEmpty())
	{
		DrawRect(FLinearColor(0.f, 0.f, 0.f, 0.6f), W / 2.f - 420.f, H - 150.f, 840.f, 48.f);
		float TextW = 0.f, TextH = 0.f;
		GetTextSize(Game->CurrentMessage, TextW, TextH, Font, 1.f);
		DrawText(Game->CurrentMessage, FLinearColor::White, W / 2.f - TextW / 2.f, H - 136.f, Font, 1.f);
	}
	DrawText(TEXT("W A S D move   Shift sprint   Space jump   right mouse button look   E talk or read"), FLinearColor(1.f, 1.f, 1.f, 0.8f), 16.f, H - 32.f, Font, 1.f);

	// What E would do here.
	if (!Game->Focus.IsEmpty())
	{
		DrawText(TEXT("E   ") + Game->PromptFor(Game->Focus), FLinearColor(1.f, 0.9f, 0.6f), W / 2.f - 100.f, H / 2.f + 60.f, Font, 1.f);
	}

	if (Game->bWon)
	{
		DrawRect(FLinearColor(0.05f, 0.08f, 0.12f, 0.8f), W / 2.f - 420.f, H / 2.f - 70.f, 840.f, 110.f);
		float TextW = 0.f, TextH = 0.f;
		GetTextSize(Game->WinText, TextW, TextH, Large, 1.f);
		DrawText(Game->WinText, FLinearColor(1.f, 0.85f, 0.4f), W / 2.f - TextW / 2.f, H / 2.f - 30.f, Large, 1.f);
	}
}
