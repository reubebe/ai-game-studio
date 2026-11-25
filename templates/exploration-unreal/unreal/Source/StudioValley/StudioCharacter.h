#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "StudioCharacter.generated.h"

class UCameraComponent;
class USpringArmComponent;
class UStaticMeshComponent;

// Third-person walker. W A S D or arrows move, Shift sprints, Space jumps, hold the right mouse
// button to look around, E talks to people and reads signs. Keys are read directly, so the project
// needs no input assets.
UCLASS()
class AStudioCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	AStudioCharacter();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	void ApplySettings(double SpeedMetres, double Sprint, double JumpMetres, double CameraMetres);
	void Teleport(const FVector& Location);
	bool IsOnGround() const;

	/** Set by the self-test instead of the keyboard: X is right, Y is forward. */
	TOptional<FVector2D> ScriptedInput;
	FVector SpawnPoint = FVector::ZeroVector;

private:
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USpringArmComponent> Arm;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UCameraComponent> Camera;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UStaticMeshComponent> Body;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> ShapeMaterial;

	float Yaw = 0.f;
	float Pitch = -18.f;
	double WalkSpeed = 600.0;
	double SprintMultiplier = 1.7;
};
