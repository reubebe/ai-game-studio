#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "Misc/OutputDevice.h"
#include "StudioRules.h"
#include "StudioWorld.h"
#include "StudioGameMode.generated.h"

// Collects error lines while the game runs, for the self-test's "no errors logged" check.
class FStudioErrorLog : public FOutputDevice
{
public:
	TArray<FString> Lines;

	virtual void Serialize(const TCHAR* Text, ELogVerbosity::Type Verbosity, const FName& Category) override
	{
		if (Verbosity <= ELogVerbosity::Error && Lines.Num() < 20)
		{
			Lines.Add(FString::Printf(TEXT("%s: %s"), *Category.ToString(), Text));
		}
	}
};

class ACharacter;
class UChildActorComponent;
class UMaterialInterface;
class UStaticMesh;
class UStaticMeshComponent;

// Starts the game from the studio's data: builds the level from engine basic shapes, places the
// player and runs the game rules Game Studio compiles (objectives, dialogue, gates; see StudioRules.h).
// Picking up collectibles, walking into zones and pressing E near a person or sign are the events the
// rules hear.
//   -studio-smoke              headless self-test; prints one GSTUDIO_SMOKE line (JSON) and exits 0 or 1
//   -studio-telemetry          prints one GSTUDIO line (JSON) per rule run for Game Studio's run console
//   -studio-screenshot=<name>  saves <name>.png to the game's Saved/Screenshots folder and exits
//                              (packaged Mac games run in the App Sandbox, so that is inside its container)
// Config/DefaultGame.ini, [/Script/StudioValley.StudioGameMode], can make the player another character
// (PlayerPawn, PlayerController, PlayerLook) and the light realistic (bRealisticLight); without them
// the player is the built-in walker (AStudioCharacter).
UCLASS(Config = Game)
class AStudioGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AStudioGameMode();
	virtual ~AStudioGameMode() override;

	virtual void InitGame(const FString& MapName, const FString& Options, FString& ErrorMessage) override;
	virtual void StartPlay() override;
	/** Shows the pointer for the player (Unreal hides it by default). */
	virtual void PostLogin(APlayerController* NewPlayer) override;
	/** The layout's spawn point: the engine's Entry map has a start of its own, which Unreal sometimes chose. */
	virtual AActor* ChoosePlayerStart_Implementation(AController* Player) override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;

	bool Collect(const FString& Id);
	/** Talks to the person or reads the sign in reach (what E does). */
	bool Interact();
	int32 CountOfType(const FString& Type) const;
	TArray<FString> IdsOfType(const FString& Type) const;
	ACharacter* PlayerCharacter() const;

	// What the rules can do (FStudioRules calls these).
	void ShowMessage(const FString& Text, float Seconds);
	/** Shows and frees the pointer (Esc), or captures it again for looking around (a click). */
	void FreePointer(APlayerController* PC, bool bFree);
	void ShowWin(const FString& Text);
	bool OpenGate(const FString& Id);
	bool IsGateOpen(const FString& Id) const;
	bool SetObjectVisible(const FString& Id, bool bVisible);
	void PlayCue(const FString& Cue);
	int32 CollectedCount(const FString& Kind) const;
	int32 TotalCount(const FString& Kind) const;
	FString PromptFor(const FString& Id) const;

	FStudioWorld World;
	FString LoadError;
	TMap<FString, TWeakObjectPtr<AActor>> Nodes;
	/** Collected item id to its kind. */
	TMap<FString, FString> Collected;
	TSet<FString> ZonesEntered;
	TArray<FString> MessagesShown;
	TArray<FString> SoundsPlayed;
	FString Objective;
	FString CurrentMessage;
	FString WinText;
	bool bWon = false;
	/** The person or sign the player can use with E, or empty. */
	FString Focus;
	TUniquePtr<FStudioRules> Rules;

	/** The player's character class; empty means the built-in walker. */
	UPROPERTY(Config)
	FSoftClassPath PlayerPawn;

	/** The player controller class; empty means Unreal's default. */
	UPROPERTY(Config)
	FSoftClassPath PlayerController;

	/**
	 * An actor shown as the player's body: it goes into the character's "VisualOverride" child actor
	 * component and the character's own mesh keeps animating unseen (how Epic's Game Animation Sample
	 * swaps bodies, for example to a MetaHuman).
	 */
	UPROPERTY(Config)
	FSoftClassPath PlayerLook;

	/** Light for projects with Lumen on: no fill light, clouds and height fog. */
	UPROPERTY(Config)
	bool bRealisticLight = false;

	/** Shows the pointer and leaves it free (the built-in walker looks with the right mouse button). */
	UPROPERTY(Config)
	bool bShowPointer = true;
	/** Esc gave the pointer back in a game that looks around with the mouse; a click takes it again. */
	bool bPointerFreed = false;

private:
	void BuildLevel();
	AActor* BuildObject(const FStudioObject& O);
	AActor* NewActor(const FVector& Location, const FRotator& Rotation, double Scale);
	UStaticMeshComponent* Part(AActor* Owner, UStaticMesh* Mesh, const FVector& LocationMetres, const FVector& SizeMetres, const FColor& Color, bool bSolid, const FRotator& Rotation = FRotator::ZeroRotator);
	const FStudioObject* Find(const FString& Id) const;
	FString FindFocus(const FVector& Location) const;
	void NextMessage();
	bool SaveScreenshot(const FString& Path);
	void TickSmokeTest(float DeltaSeconds);
	void GoToFirstItem(ACharacter* Player);
	void TeleportPlayer(ACharacter* Player, const FVector& Location) const;
	/** Keeps the configured look on the player; returns whether it is shown. */
	bool KeepPlayerLook(ACharacter* Player);
	/** Short hair over the look's scalp when its own hair cannot be drawn here. */
	void CoverHair(AActor* Look);
	void AddRealisticSky(const FActorSpawnParameters& Params);
	/** A photo-scanned model in /Game/GameStudioNature, or none (the simple shapes are drawn then). */
	UStaticMesh* NatureMesh(const TCHAR* Name) const;
	/** Draws a photo-scanned model over an object; its simple shapes stay, unseen, for collision. */
	void Dress(AActor* Owner, const FString& Id, const TCHAR* Name, double Scale);
	/** Draws a villager as a real person breathing in place, when the realistic people are there. */
	void Person(AActor* Owner);
	/** Puts a photographed surface (stone, wood) from /Game/GameStudioNature/M on a simple shape. */
	void Surface(UStaticMeshComponent* Shape, const TCHAR* Name) const;
	/** Grass and ferns over the ground, clear of water, zones, gates and people. */
	void PlantGround(AActor* Ground);

	TWeakObjectPtr<AActor> StudioStart;
	TWeakObjectPtr<UChildActorComponent> LookSlot;
	FString LookProblem;

	UPROPERTY()
	TObjectPtr<UClass> LookClass;
	void FinishSmokeTest();

	UPROPERTY()
	TObjectPtr<UStaticMesh> Cube;

	UPROPERTY()
	TObjectPtr<UStaticMesh> Sphere;

	UPROPERTY()
	TObjectPtr<UStaticMesh> Cylinder;

	UPROPERTY()
	TObjectPtr<UStaticMesh> Cone;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> ShapeMaterial;

	struct FCheck
	{
		FString Name;
		bool bOk = false;
		FString Detail;
	};

	bool bSmoke = false;
	int32 SmokePhase = 0;
	int32 ZoneIndex = 0;
	float SmokeClock = 0.f;
	FVector WalkStart = FVector::ZeroVector;
	TArray<FCheck> Checks;
	TArray<FString> Items;
	TArray<FString> Zones;
	TArray<FString> People;

	struct FGate
	{
		TWeakObjectPtr<UStaticMeshComponent> Door;
		/** The photographed door drawn over Door (realistic style), sinking with it. */
		TWeakObjectPtr<UStaticMeshComponent> Look;
		double LookZ = 0.0;
		bool bOpen = false;
		float Sunk = 0.f;
		double StartZ = 0.0;
	};
	TMap<FString, FGate> Gates;
	TSet<FString> Hidden;
	TSet<FString> InsideZones;
	TArray<TPair<FString, float>> MessageQueue;
	float MessageTime = 0.f;
	bool bTelemetry = false;
	FString ScreenshotPath;
	/** Frames since nothing was left compiling (see Tick). */
	int32 ScreenshotWait = 0;
	/** -studio-screenshot-near=<object id>[@<metres>]: the picture is taken that far (6 m) south of the object. */
	FString ScreenshotNear;
	TArray<float> FrameTimes;
	FVector ThreadTimes = FVector::ZeroVector;
	int32 Frames = 0;
	TUniquePtr<FStudioErrorLog> ErrorLog;
};
