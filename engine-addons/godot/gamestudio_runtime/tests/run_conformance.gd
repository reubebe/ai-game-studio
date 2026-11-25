extends SceneTree
## Runs the shared rule-runtime conformance fixtures against the GDScript VM.
##
## godot --headless --path <project> --script res://addons/gamestudio_runtime/tests/run_conformance.gd
## Exit code 0 when every step matches the TypeScript runtime's recorded results.

const RulesVM := preload("res://addons/gamestudio_runtime/rules_vm.gd")
const ScriptedHost := preload("res://addons/gamestudio_runtime/tests/scripted_host.gd")
const FIXTURES := "res://addons/gamestudio_runtime/tests/fixtures.json"


func _init() -> void:
	var text := FileAccess.get_file_as_string(FIXTURES)
	var data = JSON.parse_string(text)
	if typeof(data) != TYPE_DICTIONARY:
		print("GSTUDIO_CONFORMANCE FAIL cannot read fixtures")
		quit(2)
		return
	var failures := 0
	var steps := 0
	for scenario in data.get("scenarios", []):
		var vm = RulesVM.new()
		var load_error: String = vm.load_program(scenario["program"])
		if load_error != "":
			print("FAIL %s: %s" % [scenario["name"], load_error])
			failures += 1
			continue
		var index := 0
		for step in scenario.get("steps", []):
			index += 1
			steps += 1
			var host = ScriptedHost.new(scenario.get("queries", {}), scenario.get("results", {}))
			var r: Dictionary = vm.run(str(step["event"]), step.get("payload", {}), host)
			var expect: Dictionary = step["expect"]
			var actual := {
				"handled": r["handled"],
				"halted": r["halted"],
				"error": r["error"] != null,
				"errorNode": r["errorNode"],
				"variables": vm.variables,
				"calls": host.calls,
				"logs": r["logs"],
				"trace": r["trace"],
			}
			for key in expect:
				if not _deep_equal(expect[key], actual.get(key)):
					failures += 1
					print("FAIL %s step %d (%s): expected %s, got %s" % [scenario["name"], index, key, JSON.stringify(expect[key]), JSON.stringify(actual.get(key))])
	if failures == 0:
		print("GSTUDIO_CONFORMANCE PASS %d steps" % steps)
		quit(0)
	else:
		print("GSTUDIO_CONFORMANCE FAIL %d mismatches in %d steps" % [failures, steps])
		quit(1)


func _deep_equal(a: Variant, b: Variant) -> bool:
	var ta := typeof(a)
	var tb := typeof(b)
	if (ta == TYPE_INT or ta == TYPE_FLOAT) and (tb == TYPE_INT or tb == TYPE_FLOAT):
		return float(a) == float(b)
	if ta != tb:
		return false
	if ta == TYPE_DICTIONARY:
		if a.size() != b.size():
			return false
		for key in a:
			if not b.has(key) or not _deep_equal(a[key], b[key]):
				return false
		return true
	if ta == TYPE_ARRAY:
		if a.size() != b.size():
			return false
		for i in range(a.size()):
			if not _deep_equal(a[i], b[i]):
				return false
		return true
	return a == b
