#include "StudioGameMode.h"
#include "Components/ChildActorComponent.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PointLightComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Character.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/InputSettings.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/PlayerStart.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/CommandLine.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "TextureResource.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Sound/SoundWaveProcedural.h"
#include "StudioCharacter.h"
#include "StudioHUD.h"
#include "StudioRules.h"
#include "StudioValley.h"
#include "UObject/ConstructorHelpers.h"
#include <stdio.h>
#if WITH_EDITOR
#include "AssetCompilingManager.h"
#include "ShaderCompiler.h"
#endif

AStudioGameMode::AStudioGameMode()
{
	PrimaryActorTick.bCanEverTick = true;
	DefaultPawnClass = AStudioCharacter::StaticClass();
	HUDClass = AStudioHUD::StaticClass();
	// Hard references, so packaging cooks the engine shapes the level is built from.
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderMesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> ConeMesh(TEXT("/Engine/BasicShapes/Cone.Cone"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Material(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	Cube = CubeMesh.Object;
	Sphere = SphereMesh.Object;
	Cylinder = CylinderMesh.Object;
	Cone = ConeMesh.Object;
	ShapeMaterial = Material.Object;
}

AStudioGameMode::~AStudioGameMode() = default;

void AStudioGameMode::InitGame(const FString& MapName, const FString& Options, FString& ErrorMessage)
{
	Super::InitGame(MapName, Options, ErrorMessage);
	bSmoke = FParse::Param(FCommandLine::Get(), TEXT("studio-smoke"));
	bTelemetry = FParse::Param(FCommandLine::Get(), TEXT("studio-telemetry"));
	FParse::Value(FCommandLine::Get(), TEXT("studio-screenshot="), ScreenshotPath);
	ErrorLog = MakeUnique<FStudioErrorLog>();
	GLog->AddOutputDevice(ErrorLog.Get());
	// Another character and controller, when the project names them (players spawn after InitGame).
	if (!PlayerPawn.IsNull())
	{
		if (UClass* Pawn = PlayerPawn.TryLoadClass<APawn>())
		{
			DefaultPawnClass = Pawn;
		}
		else
		{
			UE_LOG(LogStudio, Error, TEXT("The player character %s did not load."), *PlayerPawn.ToString());
		}
	}
	if (!PlayerController.IsNull())
	{
		if (UClass* Controller = PlayerController.TryLoadClass<APlayerController>())
		{
			PlayerControllerClass = Controller;
		}
		else
		{
			UE_LOG(LogStudio, Error, TEXT("The player controller %s did not load."), *PlayerController.ToString());
		}
	}
	if (!FStudioWorld::Load(World, LoadError))
	{
		UE_LOG(LogStudio, Error, TEXT("%s"), *LoadError);
	}
	BuildLevel();
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	StudioStart = GetWorld()->SpawnActor<APlayerStart>(APlayerStart::StaticClass(), FStudioWorld::ToUnreal(World.SpawnX, World.SpawnZ, 1.2), FRotator::ZeroRotator, Params);
	Rules = MakeUnique<FStudioRules>(*this, bTelemetry);
	Rules->Load();
}

void AStudioGameMode::StartPlay()
{
	Super::StartPlay();
	gsrules::Value Ids = gsrules::Value::Array();
	for (const FStudioRules::FProgram& Program : Rules->Programs)
	{
		Ids.items.push_back(gsrules::Value::Text(FStudioRules::Utf8(Program.Id)));
	}
	gsrules::Value Errors = gsrules::Value::Array();
	for (const FString& Problem : Rules->Errors)
	{
		Errors.items.push_back(gsrules::Value::Text(FStudioRules::Utf8(Problem)));
	}
	gsrules::Value Ready = gsrules::Value::Object();
	Ready.Set("type", gsrules::Value::Text("ready"));
	Ready.Set("programs", Ids);
	Ready.Set("worldError", gsrules::Value::Text(FStudioRules::Utf8(LoadError)));
	Ready.Set("ruleErrors", Errors);
	Rules->Emit(Ready);
	Rules->Fire(TEXT("start"), gsrules::Value::Object());
}

// Unreal hides the pointer and locks it inside the game window until the player switches apps. The
// player looks around while holding the right mouse button, so the pointer stays visible (set here, as
// soon as the player controller exists, before the window can capture the mouse with it hidden) and
// free to leave the window (Config/DefaultInput.ini), as in the Unity version.
void AStudioGameMode::PostLogin(APlayerController* NewPlayer)
{
	Super::PostLogin(NewPlayer);
	if (NewPlayer && bShowPointer)
	{
		NewPlayer->bShowMouseCursor = true;
	}
}

AActor* AStudioGameMode::ChoosePlayerStart_Implementation(AController* Player)
{
	if (AActor* Start = StudioStart.Get())
	{
		return Start;
	}
	return Super::ChoosePlayerStart_Implementation(Player);
}

void AStudioGameMode::EndPlay(const EEndPlayReason::Type Reason)
{
	if (ErrorLog && GLog)
	{
		GLog->RemoveOutputDevice(ErrorLog.Get());
	}
	Super::EndPlay(Reason);
}

AActor* AStudioGameMode::NewActor(const FVector& Location, const FRotator& Rotation, double Scale)
{
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AActor* Actor = GetWorld()->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, Params);
	USceneComponent* Root = NewObject<USceneComponent>(Actor, TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	Actor->SetRootComponent(Root);
	Root->RegisterComponent();
	Actor->AddInstanceComponent(Root);
	Actor->SetActorLocationAndRotation(Location, Rotation);
	Actor->SetActorScale3D(FVector(Scale));
	return Actor;
}

// Basic shapes are 100 cm across, so a size in metres is also the scale.
UStaticMeshComponent* AStudioGameMode::Part(AActor* Owner, UStaticMesh* Mesh, const FVector& LocationMetres, const FVector& SizeMetres, const FColor& Color, bool bSolid, const FRotator& Rotation)
{
	UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(Owner);
	C->SetMobility(EComponentMobility::Movable);
	C->SetStaticMesh(Mesh);
	C->SetupAttachment(Owner->GetRootComponent());
	C->SetRelativeLocationAndRotation(LocationMetres * 100.0, Rotation);
	C->SetRelativeScale3D(SizeMetres);
	C->SetCollisionProfileName(bSolid ? UCollisionProfile::BlockAll_ProfileName : UCollisionProfile::NoCollision_ProfileName);
	if (ShapeMaterial)
	{
		UMaterialInstanceDynamic* Paint = UMaterialInstanceDynamic::Create(ShapeMaterial, C);
		Paint->SetVectorParameterValue(TEXT("Color"), FLinearColor::FromSRGBColor(Color));
		C->SetMaterial(0, Paint);
	}
	C->RegisterComponent();
	Owner->AddInstanceComponent(C);
	return C;
}

void AStudioGameMode::BuildLevel()
{
	const double W = World.Width;
	const double D = World.Depth;
	AActor* Ground = NewActor(FVector::ZeroVector, FRotator::ZeroRotator, 1.0);
	const FLinearColor GroundColor = FStudioWorld::ParseColor(World.Ground, FLinearColor::FromSRGBColor(FColor(90, 125, 60)));
	Part(Ground, Cube, FVector(0, 0, -0.5), FVector(D, W, 1.0), GroundColor.ToFColor(true), true);
	// Invisible walls along the map edge, as in the Godot version.
	const FVector Walls[4][2] = {
		{FVector(D / 2 + 0.5, 0, 3), FVector(1, W + 2, 8)},
		{FVector(-D / 2 - 0.5, 0, 3), FVector(1, W + 2, 8)},
		{FVector(0, W / 2 + 0.5, 3), FVector(D + 2, 1, 8)},
		{FVector(0, -W / 2 - 0.5, 3), FVector(D + 2, 1, 8)},
	};
	for (const auto& Wall : Walls)
	{
		Part(Ground, Cube, Wall[0], Wall[1], FColor::White, true)->SetVisibility(false);
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	// The sun shines from behind the start view (checked in a packaged build's screenshot); a weak
	// fill light without shadows keeps shaded sides from going black.
	ADirectionalLight* Sun = GetWorld()->SpawnActor<ADirectionalLight>(ADirectionalLight::StaticClass(), FVector(0, 0, 1000), FRotator(-World.SunElevation, 180.0 + World.SunHeading, 0), Params);
	if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		Light->SetMobility(EComponentMobility::Movable);
		Light->SetAtmosphereSunLight(true);
		Light->SetIntensity(8.f);
		// The level's sunlight colour (white when it has none).
		Light->SetLightColor(FStudioWorld::ParseColor(World.SunColor, FLinearColor::White));
	}
	if (bRealisticLight)
	{
		AddRealisticSky(Params);
	}
	else
	{
		ADirectionalLight* Fill = GetWorld()->SpawnActor<ADirectionalLight>(ADirectionalLight::StaticClass(), FVector(0, 0, 1000), FRotator(-35.0, World.SunHeading, 0), Params);
		if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Fill->GetLightComponent()))
		{
			Light->SetMobility(EComponentMobility::Movable);
			Light->SetIntensity(2.5f);
			Light->SetCastShadows(false);
			Light->SetAtmosphereSunLight(false);
		}
	}
	GetWorld()->SpawnActor<ASkyAtmosphere>(ASkyAtmosphere::StaticClass(), FTransform::Identity, Params);
	ASkyLight* SkyLight = GetWorld()->SpawnActor<ASkyLight>(ASkyLight::StaticClass(), FTransform::Identity, Params);
	if (USkyLightComponent* Sky = SkyLight->GetLightComponent())
	{
		Sky->SetMobility(EComponentMobility::Movable);
		Sky->bRealTimeCapture = true;
		Sky->RecaptureSky();
	}

	for (const FStudioObject& O : World.Objects)
	{
		if (Nodes.Contains(O.Id))
		{
			continue;
		}
		if (AActor* Actor = BuildObject(O))
		{
			Nodes.Add(O.Id, Actor);
			if (O.Type == TEXT("collectible"))
			{
				Items.Add(O.Id);
			}
			else if (O.Type == TEXT("zone"))
			{
				Zones.Add(O.Id);
			}
			else if (O.Type == TEXT("npc"))
			{
				People.Add(O.Id);
			}
		}
	}
	UE_LOG(LogStudio, Display, TEXT("Built %d of %d objects for %s"), Nodes.Num(), World.Objects.Num(), *World.Name);
}

AActor* AStudioGameMode::BuildObject(const FStudioObject& O)
{
	static const TSet<FString> Known = {TEXT("tree"), TEXT("rock"), TEXT("collectible"), TEXT("npc"), TEXT("gate"), TEXT("zone"), TEXT("water"), TEXT("sign"), TEXT("torch")};
	if (!Known.Contains(O.Type))
	{
		return nullptr;
	}
	AActor* A = NewActor(FStudioWorld::ToUnreal(O.X, O.Z), FRotator(0, O.Rotation, 0), O.Scale);
	const FColor Bark(122, 86, 52);
	const double Unscale = 1.0 / FMath::Max(0.2, O.Scale);
	if (O.Type == TEXT("tree"))
	{
		if (O.Variant == TEXT("baobab"))
		{
			Part(A, Cylinder, FVector(0, 0, 1.5), FVector(1.4, 1.4, 3.0), Bark, true);
			Part(A, Sphere, FVector(0, 0, 3.4), FVector(4.2, 4.2, 1.4), FColor(92, 140, 64), false);
		}
		else if (O.Variant == TEXT("tall"))
		{
			Part(A, Cylinder, FVector(0, 0, 1.3), FVector(0.45, 0.45, 2.6), Bark, true);
			Part(A, Cone, FVector(0, 0, 4.4), FVector(1.9, 1.9, 3.8), FColor(51, 115, 61), false);
		}
		else
		{
			Part(A, Cylinder, FVector(0, 0, 1.1), FVector(0.5, 0.5, 2.2), Bark, true);
			Part(A, Sphere, FVector(0, 0, 3.1), FVector(3.0, 3.0, 2.6), FColor(74, 135, 63), false);
		}
	}
	else if (O.Type == TEXT("rock"))
	{
		Part(A, Sphere, FVector(0, 0, 0.45), FVector(1.3, 1.6, 1.0), FColor(138, 143, 150), true);
	}
	else if (O.Type == TEXT("collectible"))
	{
		Part(A, Cube, FVector(0, 0, 1.1), FVector(0.45, 0.45, 0.45), FColor(245, 197, 66), false, FRotator(45, 0, 45));
	}
	else if (O.Type == TEXT("npc"))
	{
		const FLinearColor Cloth = FStudioWorld::ParseColor(O.Color, FLinearColor::FromSRGBColor(FColor(200, 135, 58)));
		Part(A, Cylinder, FVector(0, 0, 0.9), FVector(0.8, 0.8, 1.8), Cloth.ToFColor(true), true);
		Part(A, Sphere, FVector(0, 0, 1.95), FVector(0.45, 0.45, 0.45), FColor(107, 74, 50), false);
	}
	else if (O.Type == TEXT("gate"))
	{
		const FColor Stone(158, 140, 115);
		const double Half = FMath::Max(1.0, O.Width) / 2.0;
		Part(A, Cube, FVector(0, -Half - 0.45, 2.2), FVector(0.9, 0.9, 4.4), Stone, true);
		Part(A, Cube, FVector(0, Half + 0.45, 2.2), FVector(0.9, 0.9, 4.4), Stone, true);
		Part(A, Cube, FVector(0, 0, 4.6), FVector(1.0, Half * 2 + 1.8, 0.5), Stone, false);
		// Closed until a rule opens it (explore.openGate).
		FGate Gate;
		Gate.Door = Part(A, Cube, FVector(0, 0, 1.6), FVector(0.3, Half * 2, 3.2), FColor(115, 77, 41), true);
		Gates.Add(O.Id, Gate);
	}
	else if (O.Type == TEXT("zone"))
	{
		Part(A, Cylinder, FVector(0, 0, 0.02), FVector(O.Radius * 2 * Unscale, O.Radius * 2 * Unscale, 0.02), FColor(250, 219, 128), false)->SetVisibility(O.bVisible);
	}
	else if (O.Type == TEXT("water"))
	{
		Part(A, Cylinder, FVector(0, 0, 0.03), FVector(O.Radius * 2 * Unscale, O.Radius * 2 * Unscale, 0.04), FColor(61, 120, 179), false);
	}
	else if (O.Type == TEXT("sign"))
	{
		Part(A, Cube, FVector(0, 0, 0.7), FVector(0.15, 0.15, 1.4), Bark, true);
		Part(A, Cube, FVector(0, 0, 1.45), FVector(0.1, 1.4, 0.7), FColor(168, 128, 77), false);
	}
	else if (O.Type == TEXT("torch"))
	{
		Part(A, Cylinder, FVector(0, 0, 0.6), FVector(0.15, 0.15, 1.2), Bark, true);
		Part(A, Sphere, FVector(0, 0, 1.35), FVector(0.3, 0.3, 0.3), FColor(255, 153, 51), false);
		UPointLightComponent* Flame = NewObject<UPointLightComponent>(A);
		Flame->SetMobility(EComponentMobility::Movable);
		Flame->SetupAttachment(A->GetRootComponent());
		Flame->SetRelativeLocation(FVector(0, 0, 150));
		Flame->SetLightColor(FLinearColor(1.f, 0.65f, 0.3f));
		Flame->SetAttenuationRadius(600.f);
		Flame->RegisterComponent();
		A->AddInstanceComponent(Flame);
	}
	return A;
}

const FStudioObject* AStudioGameMode::Find(const FString& Id) const
{
	return World.Objects.FindByPredicate([&Id](const FStudioObject& O) { return O.Id == Id; });
}

int32 AStudioGameMode::CountOfType(const FString& Type) const
{
	return IdsOfType(Type).Num();
}

TArray<FString> AStudioGameMode::IdsOfType(const FString& Type) const
{
	TArray<FString> Out;
	for (const FStudioObject& O : World.Objects)
	{
		if (O.Type == Type && Nodes.Contains(O.Id))
		{
			Out.Add(O.Id);
		}
	}
	return Out;
}

ACharacter* AStudioGameMode::PlayerCharacter() const
{
	return Cast<ACharacter>(UGameplayStatics::GetPlayerPawn(this, 0));
}

void AStudioGameMode::TeleportPlayer(ACharacter* Player, const FVector& Location) const
{
	Player->SetActorLocation(Location, false, nullptr, ETeleportType::TeleportPhysics);
	Player->GetCharacterMovement()->Velocity = FVector::ZeroVector;
}

// Volumetric clouds and a thin height fog that takes the sky's colour; the sky light already follows
// the atmosphere (real-time capture), and Lumen bounces the sun.
void AStudioGameMode::AddRealisticSky(const FActorSpawnParameters& Params)
{
	GetWorld()->SpawnActor<AVolumetricCloud>(AVolumetricCloud::StaticClass(), FTransform::Identity, Params);
	AExponentialHeightFog* Fog = GetWorld()->SpawnActor<AExponentialHeightFog>(AExponentialHeightFog::StaticClass(), FVector(0, 0, -200), FRotator::ZeroRotator, Params);
	if (UExponentialHeightFogComponent* Haze = Fog ? Fog->GetComponent() : nullptr)
	{
		Haze->SetFogDensity(0.004f);
		Haze->SetFogHeightFalloff(0.2f);
		Haze->SetStartDistance(1500.f);
	}
}

// The configured look (Config: PlayerLook) goes into the character's "VisualOverride" child actor
// component. The character's own mesh is hidden but keeps posing every frame, because the look copies
// its pose. Checked each frame: the character's own blueprints may reset the slot when they start.
bool AStudioGameMode::KeepPlayerLook(ACharacter* Player)
{
	if (PlayerLook.IsNull() || !LookProblem.IsEmpty())
	{
		return false;
	}
	UChildActorComponent* Slot = LookSlot.Get();
	if (!Slot || Slot->GetOwner() != Player)
	{
		Slot = nullptr;
		TInlineComponentArray<UChildActorComponent*> Slots(Player);
		for (UChildActorComponent* Candidate : Slots)
		{
			if (Candidate->GetFName() == TEXT("VisualOverride"))
			{
				Slot = Candidate;
			}
		}
		LookSlot = Slot;
	}
	if (!LookClass)
	{
		LookClass = PlayerLook.TryLoadClass<AActor>();
	}
	UClass* Look = LookClass;
	if (!Slot || !Look)
	{
		LookProblem = !Look ? FString::Printf(TEXT("%s did not load"), *PlayerLook.ToString()) : FString::Printf(TEXT("%s has no VisualOverride component"), *Player->GetClass()->GetName());
		UE_LOG(LogStudio, Error, TEXT("The player's look: %s."), *LookProblem);
		return false;
	}
	if (Slot->GetChildActorClass() != Look)
	{
		Slot->SetChildActorClass(Look);
	}
	if (USkeletalMeshComponent* Mesh = Player->GetMesh())
	{
		Mesh->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
		if (Mesh->IsVisible())
		{
			Mesh->SetVisibility(false, false);
		}
	}
	return Slot->GetChildActor() != nullptr && Slot->GetChildActor()->IsA(Look);
}

bool AStudioGameMode::Collect(const FString& Id)
{
	const TWeakObjectPtr<AActor>* Node = Nodes.Find(Id);
	const FStudioObject* O = Find(Id);
	if (Collected.Contains(Id) || !Node || !Node->IsValid() || !O || O->Type != TEXT("collectible"))
	{
		return false;
	}
	Collected.Add(Id, O->Kind);
	(*Node)->SetActorHiddenInGame(true);
	(*Node)->SetActorEnableCollision(false);
	UE_LOG(LogStudio, Display, TEXT("collected %s"), *Id);
	gsrules::Value Payload = gsrules::Value::Object();
	Payload.Set("itemId", gsrules::Value::Text(FStudioRules::Utf8(Id)));
	Payload.Set("kind", gsrules::Value::Text(FStudioRules::Utf8(O->Kind)));
	Rules->Fire(TEXT("collect"), Payload);
	return true;
}

bool AStudioGameMode::Interact()
{
	const FStudioObject* O = Focus.IsEmpty() ? nullptr : Find(Focus);
	if (!O)
	{
		return false;
	}
	if (O->Type == TEXT("sign"))
	{
		ShowMessage(O->Text, 6.f);
	}
	gsrules::Value Payload = gsrules::Value::Object();
	Payload.Set("targetId", gsrules::Value::Text(FStudioRules::Utf8(O->Id)));
	Rules->Fire(TEXT("interact"), Payload);
	return true;
}

FString AStudioGameMode::PromptFor(const FString& Id) const
{
	const FStudioObject* O = Find(Id);
	if (!O)
	{
		return FString();
	}
	return O->Type == TEXT("npc") ? FString::Printf(TEXT("Talk to %s"), O->Name.IsEmpty() ? TEXT("Villager") : *O->Name) : FString(TEXT("Read the sign"));
}

FString AStudioGameMode::FindFocus(const FVector& Location) const
{
	FString Best;
	double BestDistance = TNumericLimits<double>::Max();
	for (const FStudioObject& O : World.Objects)
	{
		const double Reach = O.Type == TEXT("npc") ? 2.6 : O.Type == TEXT("sign") ? 2.4 : 0.0;
		if (Reach == 0.0 || Hidden.Contains(O.Id) || !Nodes.Contains(O.Id))
		{
			continue;
		}
		const double Distance = FVector::Dist(Location, FStudioWorld::ToUnreal(O.X, O.Z)) / 100.0;
		if (Distance <= Reach && Distance < BestDistance)
		{
			Best = O.Id;
			BestDistance = Distance;
		}
	}
	return Best;
}

void AStudioGameMode::ShowMessage(const FString& Text, float Seconds)
{
	MessagesShown.Add(Text);
	MessageQueue.Add(TPair<FString, float>(Text, FMath::Max(Seconds, 0.5f)));
	if (CurrentMessage.IsEmpty())
	{
		NextMessage();
	}
}

void AStudioGameMode::NextMessage()
{
	if (MessageQueue.Num() == 0)
	{
		CurrentMessage.Reset();
		return;
	}
	CurrentMessage = MessageQueue[0].Key;
	MessageTime = MessageQueue[0].Value;
	MessageQueue.RemoveAt(0);
}

void AStudioGameMode::ShowWin(const FString& Text)
{
	bWon = true;
	WinText = Text;
}

bool AStudioGameMode::OpenGate(const FString& Id)
{
	FGate* Gate = Gates.Find(Id);
	if (!Gate)
	{
		return false;
	}
	if (!Gate->bOpen)
	{
		Gate->bOpen = true;
		if (UStaticMeshComponent* Door = Gate->Door.Get())
		{
			Gate->StartZ = Door->GetRelativeLocation().Z;
			Door->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		}
	}
	return true;
}

bool AStudioGameMode::IsGateOpen(const FString& Id) const
{
	const FGate* Gate = Gates.Find(Id);
	return Gate && Gate->bOpen;
}

bool AStudioGameMode::SetObjectVisible(const FString& Id, bool bVisible)
{
	AActor* Actor = Nodes.FindRef(Id).Get();
	if (!Actor)
	{
		return false;
	}
	Actor->SetActorHiddenInGame(!bVisible);
	Actor->SetActorEnableCollision(bVisible);
	if (bVisible)
	{
		Hidden.Remove(Id);
	}
	else
	{
		Hidden.Add(Id);
	}
	return true;
}

int32 AStudioGameMode::CollectedCount(const FString& Kind) const
{
	int32 Count = 0;
	for (const TPair<FString, FString>& Item : Collected)
	{
		Count += Item.Value == Kind ? 1 : 0;
	}
	return Count;
}

int32 AStudioGameMode::TotalCount(const FString& Kind) const
{
	int32 Count = 0;
	for (const FStudioObject& O : World.Objects)
	{
		Count += O.Type == TEXT("collectible") && O.Kind == Kind ? 1 : 0;
	}
	return Count;
}

// The template's sound cues, made at play time so the project needs no audio files (as sound_bank.gd does).
void AStudioGameMode::PlayCue(const FString& Cue)
{
	SoundsPlayed.Add(Cue);
	TArray<float> Freqs;
	float Duration = 0.f;
	float Volume = 0.35f;
	if (Cue == TEXT("chime"))
	{
		Freqs = {880.f, 1318.5f};
		Duration = 0.45f;
	}
	else if (Cue == TEXT("gate"))
	{
		Freqs = {98.f, 146.8f};
		Duration = 1.6f;
		Volume = 0.5f;
	}
	else if (Cue == TEXT("success"))
	{
		Freqs = {523.3f, 659.3f, 784.f};
		Duration = 1.2f;
	}
	else if (Cue == TEXT("error"))
	{
		Freqs = {196.f, 207.7f};
		Duration = 0.5f;
	}
	else
	{
		return;
	}
	constexpr int32 Rate = 22050;
	const int32 Count = FMath::FloorToInt32(Rate * Duration);
	TArray<int16> Samples;
	Samples.SetNumZeroed(Count);
	for (int32 i = 0; i < Count; ++i)
	{
		const float T = static_cast<float>(i) / Rate;
		const float Envelope = FMath::Min(1.f, T * 60.f) * FMath::Square(1.f - static_cast<float>(i) / Count);
		float Sample = 0.f;
		for (const float F : Freqs)
		{
			Sample += FMath::Sin(UE_TWO_PI * F * T);
		}
		Sample = FMath::Clamp(Sample / Freqs.Num() * Envelope * Volume, -1.f, 1.f);
		Samples[i] = static_cast<int16>(Sample * 32767.f);
	}
	USoundWaveProcedural* Wave = NewObject<USoundWaveProcedural>(this);
	Wave->SetSampleRate(Rate);
	Wave->NumChannels = 1;
	Wave->Duration = Duration;
	Wave->bLooping = false;
	Wave->QueueAudio(reinterpret_cast<const uint8*>(Samples.GetData()), Samples.Num() * static_cast<int32>(sizeof(int16)));
	UGameplayStatics::PlaySound2D(this, Wave);
}

void AStudioGameMode::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	++Frames;
	for (const FString& Id : Items)
	{
		if (AActor* Item = Nodes.FindRef(Id).Get())
		{
			Item->AddActorWorldRotation(FRotator(0, 90.0 * DeltaSeconds, 0));
		}
	}
	if (!CurrentMessage.IsEmpty())
	{
		MessageTime -= DeltaSeconds;
		if (MessageTime <= 0.f)
		{
			NextMessage();
		}
	}
	for (TPair<FString, FGate>& Pair : Gates)
	{
		FGate& Gate = Pair.Value;
		UStaticMeshComponent* Door = Gate.Door.Get();
		if (!Gate.bOpen || Gate.Sunk >= 1.f || !Door)
		{
			continue;
		}
		// The door sinks into the ground over 2.5 seconds, as in gate.gd.
		Gate.Sunk = FMath::Min(1.f, Gate.Sunk + DeltaSeconds / 2.5f);
		FVector At = Door->GetRelativeLocation();
		At.Z = Gate.StartZ - 420.0 * FMath::SmoothStep(0.0, 1.0, static_cast<double>(Gate.Sunk));
		Door->SetRelativeLocation(At);
	}
	if (ACharacter* Player = PlayerCharacter())
	{
		if (!Cast<AStudioCharacter>(Player))
		{
			// The built-in walker does these itself.
			KeepPlayerLook(Player);
			const APlayerController* PC = Cast<APlayerController>(Player->GetController());
			if (PC && !bSmoke && PC->WasInputKeyJustPressed(EKeys::E))
			{
				Interact();
			}
			if (Player->GetActorLocation().Z < -2500.0)
			{
				TeleportPlayer(Player, FStudioWorld::ToUnreal(World.SpawnX, World.SpawnZ, 1.2));
			}
		}
		const FVector P = Player->GetActorLocation();
		for (const FStudioObject& O : World.Objects)
		{
			if (Hidden.Contains(O.Id))
			{
				continue;
			}
			const FVector At = FStudioWorld::ToUnreal(O.X, O.Z);
			const double Flat = FVector2D(P.X - At.X, P.Y - At.Y).Size();
			if (O.Type == TEXT("collectible") && Flat < 130.0 && FMath::Abs(P.Z - 100.0) < 200.0)
			{
				Collect(O.Id);
			}
			else if (O.Type == TEXT("zone"))
			{
				// Like a Godot Area3D: the event fires each time the player walks in.
				if (Flat > O.Radius * 100.0)
				{
					InsideZones.Remove(O.Id);
				}
				else if (!InsideZones.Contains(O.Id))
				{
					InsideZones.Add(O.Id);
					ZonesEntered.Add(O.Id);
					gsrules::Value Payload = gsrules::Value::Object();
					Payload.Set("zoneId", gsrules::Value::Text(FStudioRules::Utf8(O.Id)));
					Rules->Fire(TEXT("enterZone"), Payload);
				}
			}
		}
		Focus = FindFocus(P);
	}
	if (!ScreenshotPath.IsEmpty())
	{
		// A fixed view for pictures, facing north and looking slightly down: characters that look around
		// with the mouse would otherwise turn with wherever the Mac's pointer happens to move.
		if (APlayerController* PC = GetWorld()->GetFirstPlayerController())
		{
			if (!PC->IsLookInputIgnored())
			{
				PC->SetIgnoreLookInput(true);
			}
			PC->SetControlRotation(FRotator(-15.0, 0.0, 0.0));
		}
		// Run from the editor (uncooked), shaders and textures compile while the game runs: wait for them,
		// then give the light two more seconds' worth of frames to settle.
		bool bCompiling = false;
#if WITH_EDITOR
		bCompiling = (GShaderCompilingManager && GShaderCompilingManager->IsCompiling()) || FAssetCompilingManager::Get().GetNumRemainingAssets() > 0;
#endif
		ScreenshotWait = bCompiling ? 0 : ScreenshotWait + 1;
		if (Frames >= 120 && ScreenshotWait == 120)
		{
			const FString Path = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Screenshots"), FPaths::GetBaseFilename(ScreenshotPath) + TEXT(".png")));
			const bool bSaved = SaveScreenshot(Path);
			UE_LOG(LogStudio, Display, TEXT("screenshot %s: %s"), bSaved ? TEXT("saved") : TEXT("failed"), *Path);
			FPlatformMisc::RequestExit(false);
		}
	}
	if (bSmoke)
	{
		TickSmokeTest(DeltaSeconds);
	}
}

// Renders the player's view into an off-screen target and writes it as a PNG. (Metal does not let the
// game read its window's back buffer, so a scene capture is used instead.)
bool AStudioGameMode::SaveScreenshot(const FString& Path)
{
	const APlayerCameraManager* View = UGameplayStatics::GetPlayerCameraManager(this, 0);
	if (!View)
	{
		UE_LOG(LogStudio, Warning, TEXT("screenshot: no player camera"));
		return false;
	}
	const APawn* Pawn = UGameplayStatics::GetPlayerPawn(this, 0);
	const APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0);
	UE_LOG(LogStudio, Display, TEXT("screenshot view: camera at %s looking %s (fov %.0f), view target %s, camera manager %s; player at %s, control rotation %s"),
		*View->GetCameraLocation().ToCompactString(), *View->GetCameraRotation().ToCompactString(), View->GetFOVAngle(),
		*GetNameSafe(View->GetViewTarget()), *View->GetClass()->GetName(), Pawn ? *Pawn->GetActorLocation().ToCompactString() : TEXT("none"),
		PC ? *PC->GetControlRotation().ToCompactString() : TEXT("none"));
	constexpr int32 Width = 1280;
	constexpr int32 Height = 720;
	UTextureRenderTarget2D* Target = NewObject<UTextureRenderTarget2D>(this);
	Target->RenderTargetFormat = RTF_RGBA8_SRGB;
	Target->InitAutoFormat(Width, Height);
	Target->UpdateResourceImmediate(true);
	USceneCaptureComponent2D* Capture = NewObject<USceneCaptureComponent2D>(this);
	Capture->bCaptureEveryFrame = false;
	Capture->bCaptureOnMovement = false;
	Capture->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
	Capture->TextureTarget = Target;
	Capture->FOVAngle = View->GetFOVAngle();
	Capture->RegisterComponent();
	Capture->SetWorldLocationAndRotation(View->GetCameraLocation(), View->GetCameraRotation());
	Capture->CaptureScene();
	TArray<FColor> Pixels;
	FTextureRenderTargetResource* Resource = Target->GameThread_GetRenderTargetResource();
	const bool bRead = Resource && Resource->ReadPixels(Pixels);
	Capture->DestroyComponent();
	if (!bRead || Pixels.Num() != Width * Height)
	{
		UE_LOG(LogStudio, Warning, TEXT("screenshot: could not read the capture (%d pixels)"), Pixels.Num());
		return false;
	}
	for (FColor& Pixel : Pixels)
	{
		Pixel.A = 255;
	}
	TArray64<uint8> Png;
	if (!FImageUtils::CompressImage(Png, TEXT("png"), FImageView(Pixels.GetData(), Width, Height)))
	{
		UE_LOG(LogStudio, Warning, TEXT("screenshot: PNG encoding failed"));
		return false;
	}
	if (!FFileHelper::SaveArrayToFile(Png, *Path))
	{
		UE_LOG(LogStudio, Warning, TEXT("screenshot: could not write %lld bytes"), Png.Num());
		return false;
	}
	return true;
}

void AStudioGameMode::TickSmokeTest(float DeltaSeconds)
{
	SmokeClock += DeltaSeconds;
	ACharacter* Player = PlayerCharacter();
	AStudioCharacter* Walker = Cast<AStudioCharacter>(Player);
	auto Add = [this](const FString& Name, bool bOk, const FString& Detail) { Checks.Add({Name, bOk, Detail}); };
	switch (SmokePhase)
	{
	case 0:
		if (SmokeClock < 1.2f || !Player)
		{
			if (SmokeClock > 10.f)
			{
				Add(TEXT("player spawns"), false, TEXT("no player after 10 s"));
				FinishSmokeTest();
			}
			return;
		}
		Add(TEXT("level data loads"), LoadError.IsEmpty(), LoadError);
		Add(TEXT("every object is built"), Nodes.Num() == World.Objects.Num(), FString::Printf(TEXT("%d of %d"), Nodes.Num(), World.Objects.Num()));
		Add(TEXT("rule programs load"), Rules->Programs.size() > 0, FString::Printf(TEXT("%d program(s)"), static_cast<int32>(Rules->Programs.size())));
		Add(TEXT("start rules set an objective"), !Objective.IsEmpty(), Objective);
		{
			const UInputSettings* Input = GetDefault<UInputSettings>();
			const APlayerController* PC = GetWorld()->GetFirstPlayerController();
			const bool bShown = PC && PC->bShowMouseCursor;
			const FString Detail = FString::Printf(TEXT("pointer %s, lock mode %s"), bShown ? TEXT("shown") : TEXT("hidden"), *UEnum::GetValueAsString(Input->DefaultViewportMouseLockMode));
			if (bShowPointer)
			{
				Add(TEXT("the pointer stays visible and is not locked inside the game window"), bShown && Input->DefaultViewportMouseLockMode == EMouseLockMode::DoNotLock, Detail);
			}
			else
			{
				// Characters that look around with the mouse keep the pointer hidden while playing.
				Add(TEXT("the pointer is hidden for looking around with the mouse"), PC && !bShown, Detail);
			}
		}
		if (!PlayerLook.IsNull())
		{
			const bool bLook = KeepPlayerLook(Player);
			const UChildActorComponent* Slot = LookSlot.Get();
			const AActor* Shown = Slot ? Slot->GetChildActor() : nullptr;
			Add(TEXT("the player has the chosen look"), bLook && !Player->GetMesh()->IsVisible(), LookProblem.IsEmpty() ? FString::Printf(TEXT("%s on %s"), Shown ? *Shown->GetClass()->GetName() : TEXT("nothing"), *Player->GetClass()->GetName()) : LookProblem);
		}
		{
			const FVector Spawn = FStudioWorld::ToUnreal(World.SpawnX, World.SpawnZ);
			const double FromSpawn = FVector::Dist2D(Spawn, Player->GetActorLocation()) / 100.0;
			Add(TEXT("player starts at the spawn point"), FromSpawn < 1.0, FString::Printf(TEXT("%.2f m away (player at %s, spawn at %s)"), FromSpawn, *Player->GetActorLocation().ToCompactString(), *Spawn.ToCompactString()));
		}
		Add(TEXT("player rests on the ground"), Player->GetCharacterMovement()->IsMovingOnGround(), FString::Printf(TEXT("z = %.2f m"), Player->GetActorLocation().Z / 100.0));
		WalkStart = Player->GetActorLocation();
		if (Walker)
		{
			Walker->ScriptedInput = FVector2D(0.0, 1.0);
		}
		SmokePhase = 1;
		SmokeClock = 0.f;
		break;
	case 1:
		if (!Walker)
		{
			Player->AddMovementInput(Player->GetActorForwardVector(), 1.f);
		}
		// Other characters speed up more gently (the Game Animation Sample's walker), so they get longer.
		if (SmokeClock >= (Walker ? 0.75f : 1.5f))
		{
			if (Walker)
			{
				Walker->ScriptedInput = FVector2D::ZeroVector;
			}
			SmokePhase = 2;
			SmokeClock = 0.f;
		}
		break;
	case 2:
		if (SmokeClock >= 0.15f)
		{
			const double Walked = FVector::Dist2D(WalkStart, Player->GetActorLocation()) / 100.0;
			Add(TEXT("player walks forward"), Walked > 2.0, FString::Printf(TEXT("%.2f m"), Walked));
			if (Walker)
			{
				Walker->ScriptedInput.Reset();
			}
			if (People.Num() > 0)
			{
				// Stand next to the first person, then press E (the same call the key makes).
				const FStudioObject* Npc = Find(People[0]);
				TeleportPlayer(Player, FStudioWorld::ToUnreal(Npc->X + 1.6, Npc->Z, 1.2));
				SmokePhase = 10;
			}
			else
			{
				GoToFirstItem(Player);
				SmokePhase = 3;
			}
			SmokeClock = 0.f;
		}
		break;
	case 10:
		if (SmokeClock >= 0.3f)
		{
			const int32 Before = Rules->RunsOf(TEXT("interact"));
			const int32 ErrorsBefore = Rules->Errors.Num();
			const int32 Shown = MessagesShown.Num();
			const FString Seen = Focus;
			const bool bUsed = Focus == People[0] && Interact();
			const bool bHandled = !Rules->Handles(TEXT("interact")) || Rules->RunsOf(TEXT("interact")) > Before;
			const FString Said = MessagesShown.Num() > Shown ? MessagesShown.Last() : FString(TEXT("no message"));
			Add(TEXT("talking to someone runs the interact rules"), bUsed && bHandled && Rules->Errors.Num() == ErrorsBefore, FString::Printf(TEXT("%s (focus %s): %s"), *People[0], Seen.IsEmpty() ? TEXT("none") : *Seen, *Said));
			GoToFirstItem(Player);
			SmokePhase = 3;
			SmokeClock = 0.f;
		}
		break;
	case 3:
		if (SmokeClock >= 0.25f)
		{
			if (Items.Num() > 0)
			{
				Add(TEXT("touching a collectible picks it up"), Collected.Contains(Items[0]), Items[0]);
				for (const FString& Id : Items)
				{
					Collect(Id);
				}
				Add(TEXT("every collectible can be collected"), Collected.Num() == Items.Num(), FString::Printf(TEXT("%d of %d"), Collected.Num(), Items.Num()));
			}
			SmokePhase = 4;
			SmokeClock = 0.f;
			ZoneIndex = 0;
		}
		break;
	case 4:
		if (ZoneIndex < Zones.Num())
		{
			if (SmokeClock >= 0.1f)
			{
				const FStudioObject* Z = Find(Zones[ZoneIndex++]);
				TeleportPlayer(Player, FStudioWorld::ToUnreal(Z->X, Z->Z, 1.2));
				SmokeClock = 0.f;
			}
			return;
		}
		if (SmokeClock >= 0.1f)
		{
			Add(TEXT("rules run without errors"), Rules->Errors.Num() == 0, FString::Join(Rules->Errors, TEXT("; ")));
			Add(TEXT("no errors logged"), ErrorLog->Lines.Num() == 0, FString::Join(ErrorLog->Lines, TEXT("; ")));
			FinishSmokeTest();
		}
		break;
	default:
		break;
	}
}

void AStudioGameMode::GoToFirstItem(ACharacter* Player)
{
	if (Items.Num() > 0)
	{
		const FStudioObject* First = Find(Items[0]);
		TeleportPlayer(Player, FStudioWorld::ToUnreal(First->X, First->Z, 1.2));
	}
}

void AStudioGameMode::FinishSmokeTest()
{
	if (SmokePhase == 99)
	{
		return;
	}
	SmokePhase = 99;
	bool bPass = Checks.Num() > 0;
	TArray<TSharedPtr<FJsonValue>> CheckValues;
	for (const FCheck& C : Checks)
	{
		bPass &= C.bOk;
		TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
		Item->SetStringField(TEXT("name"), C.Name);
		Item->SetBoolField(TEXT("ok"), C.bOk);
		Item->SetStringField(TEXT("detail"), C.Detail);
		CheckValues.Add(MakeShared<FJsonValueObject>(Item));
	}
	TArray<TSharedPtr<FJsonValue>> ZoneValues;
	for (const FString& Id : ZonesEntered)
	{
		ZoneValues.Add(MakeShared<FJsonValueString>(Id));
	}
	TSharedRef<FJsonObject> Observations = MakeShared<FJsonObject>();
	Observations->SetStringField(TEXT("engine"), FString::Printf(TEXT("Unreal %s"), *FEngineVersion::Current().ToString(EVersionComponent::Patch)));
	Observations->SetNumberField(TEXT("objects"), Nodes.Num());
	Observations->SetNumberField(TEXT("collectibles"), Items.Num());
	Observations->SetNumberField(TEXT("collected"), Collected.Num());
	Observations->SetArrayField(TEXT("zonesEntered"), ZoneValues);
	TArray<TSharedPtr<FJsonValue>> ProgramValues;
	for (const FStudioRules::FProgram& Program : Rules->Programs)
	{
		ProgramValues.Add(MakeShared<FJsonValueString>(Program.Id));
	}
	auto StringArray = [](const TArray<FString>& List)
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		for (const FString& Item : List)
		{
			Values.Add(MakeShared<FJsonValueString>(Item));
		}
		return Values;
	};
	TSharedRef<FJsonObject> GatesOpen = MakeShared<FJsonObject>();
	for (const TPair<FString, FGate>& Gate : Gates)
	{
		GatesOpen->SetBoolField(Gate.Key, Gate.Value.bOpen);
	}
	Observations->SetArrayField(TEXT("rules"), ProgramValues);
	Observations->SetStringField(TEXT("objective"), Objective);
	Observations->SetBoolField(TEXT("won"), bWon);
	Observations->SetArrayField(TEXT("messages"), StringArray(MessagesShown));
	Observations->SetObjectField(TEXT("gatesOpen"), GatesOpen);
	Observations->SetArrayField(TEXT("sounds"), StringArray(SoundsPlayed));
	TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
	Report->SetBoolField(TEXT("pass"), bPass);
	Report->SetArrayField(TEXT("checks"), CheckValues);
	Report->SetObjectField(TEXT("observations"), Observations);
	FString Json;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json);
	FJsonSerializer::Serialize(Report, Writer);
	// Plain stdout, so the line starts with GSTUDIO_SMOKE (log lines carry a timestamp prefix).
	const FString Line = FString::Printf(TEXT("GSTUDIO_SMOKE %s\n"), *Json);
	const FTCHARToUTF8 Utf8(*Line);
	fwrite(Utf8.Get(), 1, Utf8.Length(), stdout);
	fflush(stdout);
	UE_LOG(LogStudio, Display, TEXT("%s"), *Json);
	FPlatformMisc::RequestExitWithStatus(false, bPass ? 0 : 1);
}
