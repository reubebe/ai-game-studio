#include "StudioCharacter.h"
#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "StudioGameMode.h"
#include "UObject/ConstructorHelpers.h"

AStudioCharacter::AStudioCharacter()
{
	PrimaryActorTick.bCanEverTick = true;
	GetCapsuleComponent()->InitCapsuleSize(40.f, 90.f);
	bUseControllerRotationYaw = false;
	GetCharacterMovement()->bOrientRotationToMovement = true;
	GetCharacterMovement()->RotationRate = FRotator(0.f, 720.f, 0.f);

	Arm = CreateDefaultSubobject<USpringArmComponent>(TEXT("Arm"));
	Arm->SetupAttachment(RootComponent);
	Arm->SetUsingAbsoluteRotation(true);
	Arm->TargetArmLength = 600.f;
	Arm->SocketOffset = FVector(0.f, 0.f, 70.f);
	Arm->bDoCollisionTest = true;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Arm, USpringArmComponent::SocketName);

	// A coloured cylinder stands in for a character model (BasicShapes cylinder: 100 cm tall and wide).
	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(RootComponent);
	Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Body->SetRelativeScale3D(FVector(0.8, 0.8, 1.8));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Material(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (Cylinder.Succeeded())
	{
		Body->SetStaticMesh(Cylinder.Object);
	}
	ShapeMaterial = Material.Object;
}

void AStudioCharacter::BeginPlay()
{
	Super::BeginPlay();
	if (const AStudioGameMode* Game = GetWorld()->GetAuthGameMode<AStudioGameMode>())
	{
		const FStudioWorld& W = Game->World;
		ApplySettings(W.Speed, W.SprintMultiplier, W.JumpVelocity, W.CameraDistance);
		SpawnPoint = FStudioWorld::ToUnreal(W.SpawnX, W.SpawnZ, 1.2);
		// Start exactly at the layout's spawn point, facing north, whichever start spot the engine chose.
		Teleport(SpawnPoint);
		SetActorRotation(FRotator::ZeroRotator);
	}
}

void AStudioCharacter::ApplySettings(double SpeedMetres, double Sprint, double JumpMetres, double CameraMetres)
{
	WalkSpeed = SpeedMetres * 100.0;
	SprintMultiplier = Sprint;
	GetCharacterMovement()->MaxWalkSpeed = WalkSpeed;
	GetCharacterMovement()->JumpZVelocity = JumpMetres * 100.0;
	Arm->TargetArmLength = CameraMetres * 100.0;
	if (UMaterialInterface* Base = ShapeMaterial ? ShapeMaterial.Get() : Body->GetMaterial(0))
	{
		UMaterialInstanceDynamic* Paint = UMaterialInstanceDynamic::Create(Base, this);
		Paint->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.85f, 0.42f, 0.25f));
		Body->SetMaterial(0, Paint);
	}
}

void AStudioCharacter::Teleport(const FVector& Location)
{
	SetActorLocation(Location, false, nullptr, ETeleportType::TeleportPhysics);
	GetCharacterMovement()->Velocity = FVector::ZeroVector;
}

bool AStudioCharacter::IsOnGround() const
{
	return GetCharacterMovement()->IsMovingOnGround();
}

void AStudioCharacter::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	FVector2D Input = FVector2D::ZeroVector;
	bool bSprint = false;
	APlayerController* PC = Cast<APlayerController>(GetController());
	if (ScriptedInput.IsSet())
	{
		Input = ScriptedInput.GetValue();
	}
	else if (PC)
	{
		auto Down = [PC](const FKey& Key) { return PC->IsInputKeyDown(Key); };
		Input.Y = (Down(EKeys::W) || Down(EKeys::Up) ? 1.f : 0.f) - (Down(EKeys::S) || Down(EKeys::Down) ? 1.f : 0.f);
		Input.X = (Down(EKeys::D) || Down(EKeys::Right) ? 1.f : 0.f) - (Down(EKeys::A) || Down(EKeys::Left) ? 1.f : 0.f);
		bSprint = Down(EKeys::LeftShift) || Down(EKeys::RightShift);
		if (PC->WasInputKeyJustPressed(EKeys::SpaceBar))
		{
			Jump();
		}
		if (PC->WasInputKeyJustPressed(EKeys::E))
		{
			if (AStudioGameMode* Game = GetWorld()->GetAuthGameMode<AStudioGameMode>())
			{
				Game->Interact();
			}
		}
		if (Down(EKeys::RightMouseButton))
		{
			float DX = 0.f, DY = 0.f;
			PC->GetInputMouseDelta(DX, DY);
			Yaw += DX * 2.f;
			Pitch = FMath::Clamp(Pitch + DY * 2.f, -60.f, 10.f);
		}
	}
	GetCharacterMovement()->MaxWalkSpeed = WalkSpeed * (bSprint ? SprintMultiplier : 1.0);
	const FRotator Heading(0.f, Yaw, 0.f);
	AddMovementInput(FRotationMatrix(Heading).GetUnitAxis(EAxis::X), Input.Y);
	AddMovementInput(FRotationMatrix(Heading).GetUnitAxis(EAxis::Y), Input.X);
	Arm->SetWorldRotation(FRotator(Pitch, Yaw, 0.f));
	if (GetActorLocation().Z < -2500.f)
	{
		Teleport(SpawnPoint);
	}
}
