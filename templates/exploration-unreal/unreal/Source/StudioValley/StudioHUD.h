#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "StudioHUD.generated.h"

UCLASS()
class AStudioHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;
};
