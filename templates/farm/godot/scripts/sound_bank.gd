extends Node
## The template's sound cues, generated at startup so the project needs no audio files, plus the
## level's own sounds: imported files (res://assets/...) that replace cues by name, and looping
## background music. Keep in step with the other template's sound_bank.gd.

## Every cue played, in order, and those played from an imported file.
var played: Array = []
var played_files: Array = []
## Imported files that could not be loaded (cue or "music" -> reason).
var audio_errors: Dictionary = {}
var _streams: Dictionary = {}
var _files: Dictionary = {}
var _players: Array = []
var _next := 0
var _music: AudioStreamPlayer


func _ready() -> void:
	for i in range(4):
		var p := AudioStreamPlayer.new()
		add_child(p)
		_players.append(p)
	_music = AudioStreamPlayer.new()
	_music.name = "Music"
	add_child(_music)
	_streams["chime"] = _tone([880.0, 1318.5], 0.45, 0.35)
	_streams["coins"] = _tone([1318.5, 1760.0], 0.3, 0.3)
	_streams["rooster"] = _tone([523.3, 784.0, 659.3], 0.9, 0.3)
	_streams["rain"] = _tone([196.0, 220.0, 246.9], 1.2, 0.15)
	# Not named by rules: planting, watering and harvesting.
	_streams["plant"] = _tone([330.0, 392.0], 0.12, 0.25)
	_streams["water"] = _tone([587.3, 523.3], 0.2, 0.2)
	_streams["harvest"] = _tone([659.3, 880.0], 0.18, 0.3)


## The level's "audio": {"music": {"asset", "volume"}, "sounds": {cue: asset}}. Unknown cues and
## files that cannot be loaded are reported in audio_errors; the generated cue keeps playing.
func configure(audio) -> void:
	audio_errors.clear()
	if typeof(audio) != TYPE_DICTIONARY:
		return
	var sounds = audio.get("sounds", {})
	if typeof(sounds) == TYPE_DICTIONARY:
		for cue in sounds:
			var rel := str(sounds[cue])
			if not _streams.has(cue):
				audio_errors[cue] = "%s is not one of this template's sounds" % cue
				continue
			var stream := _load(rel)
			if stream == null:
				audio_errors[cue] = "%s could not be loaded" % rel
			else:
				_streams[cue] = stream
				_files[cue] = rel
	var music = audio.get("music", null)
	if typeof(music) == TYPE_DICTIONARY:
		var rel := str(music.get("asset", ""))
		var stream := _load(rel)
		if stream == null:
			audio_errors["music"] = "%s could not be loaded" % rel
		else:
			_music.stream = _looped(stream.duplicate())
			_music.volume_db = linear_to_db(clampf(float(music.get("volume", 0.6)), 0.0, 1.0))
			_music.play()


func _exit_tree() -> void:
	# Release the playbacks before shutdown so the audio server does not hold them past exit.
	stop_all()


func play(cue: String) -> bool:
	played.append(cue)
	if not _streams.has(cue):
		return false
	if _files.has(cue):
		played_files.append(cue)
	var p: AudioStreamPlayer = _players[_next]
	_next = (_next + 1) % _players.size()
	p.stream = _streams[cue]
	p.play()
	return true


func music_playing() -> bool:
	return _music != null and _music.stream != null and _music.playing


## Stops every sound and the music, so quitting does not leave a playback behind.
func stop_all() -> void:
	for p in _players:
		(p as AudioStreamPlayer).stop()
		(p as AudioStreamPlayer).stream = null
	if _music != null:
		_music.stop()
		_music.stream = null


static func _load(rel: String) -> AudioStream:
	if rel == "" or rel.contains("..") or rel.begins_with("/"):
		return null
	var path := "res://" + rel
	if not ResourceLoader.exists(path):
		return null
	return load(path) as AudioStream


## Makes a stream repeat: Ogg and MP3 have a loop switch, WAV a loop range.
static func _looped(stream: AudioStream) -> AudioStream:
	if stream is AudioStreamOggVorbis:
		(stream as AudioStreamOggVorbis).loop = true
	elif stream is AudioStreamMP3:
		(stream as AudioStreamMP3).loop = true
	elif stream is AudioStreamWAV:
		var w := stream as AudioStreamWAV
		w.loop_mode = AudioStreamWAV.LOOP_FORWARD
		w.loop_begin = 0
		w.loop_end = int(w.get_length() * w.mix_rate)
	return stream


static func _tone(freqs: Array, duration: float, volume: float) -> AudioStreamWAV:
	var rate := 22050
	var count := int(rate * duration)
	var data := PackedByteArray()
	data.resize(count * 2)
	for i in range(count):
		var t := float(i) / float(rate)
		var envelope := minf(1.0, t * 60.0) * pow(1.0 - float(i) / float(count), 2.0)
		var sample := 0.0
		for f in freqs:
			sample += sin(TAU * float(f) * t)
		sample = sample / float(freqs.size()) * envelope * volume
		data.encode_s16(i * 2, int(clampf(sample, -1.0, 1.0) * 32767.0))
	var wav := AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS
	wav.mix_rate = rate
	wav.stereo = false
	wav.data = data
	return wav
