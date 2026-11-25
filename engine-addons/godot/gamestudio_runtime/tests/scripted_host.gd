extends RefCounted
## Deterministic host for conformance fixtures: records calls, answers from tables.
## Mirrors ScriptedHost in packages/rules-core/src/conformance.ts.

var calls: Array = []
var _queries: Dictionary
var _results: Dictionary


func _init(queries: Dictionary, results: Dictionary) -> void:
	_queries = queries
	_results = results


func call_action(fn: String, args: Dictionary) -> Variant:
	calls.append({"fn": fn, "args": args.duplicate(true)})
	if _results.has(fn):
		var r: Dictionary = _results[fn]
		return r.duplicate(true)
	return null


func query(fn: String, args: Dictionary) -> Variant:
	if not _queries.has(fn):
		return {"__error": "No scripted answer for '%s'" % fn}
	var answer = _queries[fn]
	if typeof(answer) == TYPE_DICTIONARY:
		var key: String = str(args.get(str(answer.get("by", "")), ""))
		var values: Dictionary = answer.get("values", {})
		return values[key] if values.has(key) else answer.get("default")
	return answer
