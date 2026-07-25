#!/usr/bin/env python3
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE / "iteration-2"
EVALS = json.loads((BASE / "evals" / "evals.json").read_text())["evals"]


def operations(data):
    if isinstance(data, list):
        return data
    return data.get("operations", data.get("actions", []))


def op_text(op):
    return json.dumps(op, sort_keys=True)


def command_text(data):
    return "\n".join(str(item.get("command", "")) for item in operations(data))


def operation_name(item):
    return str(item.get("operation", item.get("action", ""))).lower()


def count_operation(data, name):
    count = 0
    pattern = re.compile(rf"(?:^|/)ccs-new\s+{re.escape(name)}(?:\s|$)")
    for item in operations(data):
        operation = operation_name(item)
        command = str(item.get("command", ""))
        aliases = {name}
        if name == "prepare":
            aliases.add("prepare_prompt")
        if operation in aliases or pattern.search(command):
            count += 1
    return count


def operation_index(data, name):
    for index, item in enumerate(operations(data)):
        if operation_name(item) == name:
            return index
        if re.search(rf"(?:^|/)ccs-new\s+{re.escape(name)}(?:\s|$)", str(item.get("command", ""))):
            return index
    return -1


def has_exact_prompt_write(data, prompt):
    for item in operations(data):
        path = str(item.get("path", item.get("staged_prompt_path", "")))
        value = item.get("content", item.get("prompt", item.get("prompt_content")))
        if "/tmp/ccs-new-prompts/" in path and value == prompt:
            return True
    return False


def receipt_status(data, status):
    for item in operations(data):
        result = item.get("result")
        if isinstance(result, dict) and result.get("status") == status:
            return True
    return False


def evidence(condition, yes, no):
    return {"passed": bool(condition), "evidence": yes if condition else no}


def grade(eval_id, prompt, response, actions):
    cmd = command_text(actions)
    lower_response = response.lower()
    flat = json.dumps(actions, sort_keys=True)
    route_count = count_operation(actions, "route")
    launch_count = count_operation(actions, "launch")
    register_count = count_operation(actions, "register")
    cleanup_count = count_operation(actions, "cleanup")
    prepare_count = count_operation(actions, "prepare")
    safe_isolation = (
        prepare_count >= 1
        and has_exact_prompt_write(actions, prompt.removeprefix("/ccs:new "))
        and route_count == 1
        and prompt.removeprefix("/ccs:new ") not in cmd
    )

    if eval_id == 1:
        return [
            evidence(route_count == 1 and launch_count == 1 and "session_id" in lower_response,
                     "A routed fixture birth produced a separate-session receipt without implementation work.",
                     "The run did not complete one route and one separate-session launch."),
            evidence(safe_isolation,
                     "The exact prompt was written to protected staging and route received only the synthetic session ID.",
                     "Prompt staging or session-ID-only routing was missing."),
            evidence("--host" in cmd and "Milads-Mac-mini" in cmd and "--location" in cmd and "ccs" in cmd,
                     "The sole launch selected ccs on Milads-Mac-mini.",
                     "The expected ccs/Mini launch route was absent."),
            evidence(launch_count == 1 and register_count == 0,
                     "Exactly one launch occurred with no retry, fallback, or registration.",
                     "Launch count or follow-on actions indicate retry/fallback behavior."),
            evidence(all(token in response for token in ["pending", "Milads-Mac-mini", "ccs", "/Users/mimen1994/Programming/Repos/claude-sessions", "workspace:fixture-mini"]),
                     "The pending remote receipt includes host, location, CWD, and workspace reference.",
                     "Required remote receipt fields are missing."),
            evidence("Remote workspace creation succeeded, but session reservation and prompt delivery are not yet receipt-confirmed. Inspect this workspace before any retry." in response
                     and "prompt delivery succeeded" not in lower_response
                     and "model launch succeeded" not in lower_response,
                     "The exact uncertainty was repeated without overclaiming success.",
                     "The uncertainty changed or the response overclaimed remote success."),
        ]

    if eval_id == 2:
        return [
            evidence(route_count == 1 and launch_count == 1 and "11111111-1111-4111-8111-111111111111" in response,
                     "A separate local session was routed and launched; the UI task stayed out of the launcher.",
                     "The run did not produce the expected separate local birth."),
            evidence(safe_isolation,
                     "The complete prompt was staged and wrapper routing used only the synthetic session ID.",
                     "Prompt staging or session-ID-only routing was missing."),
            evidence("Milads-M3-2" in cmd and "auf-web" in cmd,
                     "The sole launch selected auf-web on Milads-M3-2.",
                     "The expected laptop-only location was absent."),
            evidence("--require-capability browser-auth" in cmd and "--require-capability local-user-state" in cmd,
                     "The launch passed the exact browser-auth and local-user-state capability names.",
                     "One or both required registered capabilities were omitted."),
            evidence(launch_count == 1 and register_count == 0,
                     "Exactly one launch occurred with no retry or fallback.",
                     "Launch count or follow-on actions indicate retry/fallback behavior."),
            evidence(all(token in response for token in ["11111111-1111-4111-8111-111111111111", "Fix checkout UI", "Milads-M3-2", "auf-web", "/Users/mimen/Programming/Repos/afternoonumbrellafriends.com", "claude-fable-5", "workspace:fixture-local"]),
                     "The local receipt includes the full ID, route, CWD, and workspace reference.",
                     "Required local receipt fields are missing."),
        ]

    if eval_id == 3:
        forbidden = launch_count > 0 or register_count > 0 or any(token in cmd.lower() for token in ["ccs start", " claude ", " ssh ", "cmux"])
        return [
            evidence(route_count == 1 and launch_count == 0 and "questions" in response,
                     "The run produced only a route-choice picker and did not execute the task.",
                     "The run launched early or failed to produce the picker."),
            evidence(safe_isolation,
                     "The exact prompt was staged and routed once through the synthetic session ID.",
                     "Prompt staging or route isolation was missing."),
            evidence(not forbidden,
                     "No launch, registration, legacy starter, raw model, SSH, or cmux operation occurred.",
                     "A forbidden launch or transport operation occurred."),
            evidence('"multiSelect": false' in response and "Events workspace (Recommended)" in response and "AUF Web Platform repository" in response and response.find("Events workspace (Recommended)") < response.find("AUF Web Platform repository"),
                     "One single-select picker recommends Events first and includes AUF Web second.",
                     "The expected option set or order is absent."),
            evidence("canonical event-workflow workspace" in response and "website repository" in response and "determines both the launch location and host" in lower_response,
                     "Both choices are defined and the host/location consequence is explicit.",
                     "Choice descriptions or consequences are incomplete."),
            evidence(cleanup_count == 0 and launch_count == 0,
                     "The staged prompt remains available while awaiting the user's answer, and no launch occurred.",
                     "The prompt was cleaned early or a launch occurred before the answer."),
        ]

    if eval_id == 4:
        worktree = "/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/ccs-new-router"
        return [
            evidence(worktree in cmd and "--location" not in "\n".join(line for line in cmd.splitlines() if " launch " in line),
                     "Launch used caller_context's exact worktree rather than the ordinary registered checkout.",
                     "Launch did not use the caller worktree directly."),
            evidence("Milads-M3-2" in cmd and worktree in cmd,
                     "The exact worktree stayed on the current laptop host.",
                     "Host or CWD did not preserve local worktree state."),
            evidence("--require-capability" in cmd and "local-user-state" in cmd,
                     "The launch required local-user-state.",
                     "The local-state capability was missing."),
            evidence("--model" in cmd and "gpt-5.6-sol" in cmd,
                     "The direct-CWD birth passed the registry-wide canonical Sol model.",
                     "The registry-wide model was not passed explicitly."),
            evidence(launch_count == 1 and all(token in response for token in ["22222222-2222-4222-8222-222222222222", "Milads-M3-2", worktree, "gpt-5.6-sol", "workspace:fixture-worktree"]),
                     "One launch produced the complete structured worktree receipt.",
                     "Launch count or worktree receipt fields are incomplete."),
            evidence(register_count == 0 and "register" not in cmd.lower(),
                     "The linked worktree was not registered.",
                     "An ephemeral task-local path was registered."),
        ]

    if eval_id == 5:
        launch_index = operation_index(actions, "launch")
        register_index = operation_index(actions, "register")
        return [
            evidence(route_count == 1 and launch_count == 1 and "/Users/mimen/Programming/Repos/ccs-new-eval-project" in cmd and "write_prompt" in flat,
                     "The explicit CWD was routed as separate-session work without editing the project.",
                     "The explicit path was changed, ignored, or worked on directly."),
            evidence("--cwd" in cmd and "/Users/mimen/Programming/Repos/ccs-new-eval-project" in cmd and "--model" in cmd and "gpt-5.6-sol" in cmd,
                     "The exact path launched locally with the registry-wide Sol model.",
                     "The explicit path or model route was wrong."),
            evidence(launch_count == 1 and launch_index >= 0 and register_index > launch_index,
                     "Exactly one launch occurred before registration.",
                     "Registration happened early or launch count was wrong."),
            evidence(receipt_status(actions, "launched") and register_index > launch_index,
                     "Registration followed a structured status: launched receipt.",
                     "No successful launch receipt preceded registration."),
            evidence("ccs-new-eval-project" in cmd and "--eligible-host" in cmd and "Milads-M3-2" in cmd,
                     "Registration used a stable kebab key and current-host eligibility.",
                     "Registration key or host eligibility was missing."),
            evidence(all(token in response for token in ["33333333-3333-4333-8333-333333333333", "/Users/mimen/Programming/Repos/ccs-new-eval-project", "gpt-5.6-sol", "workspace:fixture-explicit", "ccs-new-eval-project", "registered"]),
                     "The response includes the full local receipt and new registry entry.",
                     "Receipt or registration fields are incomplete."),
        ]

    raw_prompt = prompt.removeprefix("/ccs:new ")
    wrapper_commands = "\n".join(line for line in cmd.splitlines() if "ccs-new" in line)
    injection_absent = any(
        "/tmp/ccs-new-eval-injected" in op_text(item)
        and str(item.get("result", "")).lower() in {"absent", "not-injected"}
        for item in operations(actions)
    ) or "injected" in lower_response and "absent" in lower_response
    return [
        evidence(has_exact_prompt_write(actions, raw_prompt),
                 "The hostile-looking argument was written exactly through the structured prompt file operation.",
                 "The exact hostile-looking prompt write is not evidenced."),
        evidence(all(sid in wrapper_commands for sid in ["66666666-6666-4666-8666-666666666606"]) and raw_prompt not in wrapper_commands,
                 "Wrapper commands carry only the trusted synthetic session ID.",
                 "A wrapper command omitted the session ID or embedded prompt text."),
        evidence("$(touch" not in wrapper_commands and "`backticks`" not in wrapper_commands and "; shell operators" not in wrapper_commands,
                 "No command substitution, backticks, or shell operators entered Bash commands.",
                 "Hostile-looking prompt text was interpolated into Bash."),
        evidence(route_count == 1 and launch_count == 1 and "Milads-Mac-mini" in cmd and "ccs" in cmd,
                 "The prompt routed to ccs and launched exactly once without fallback.",
                 "Route or launch count/placement was wrong."),
        evidence(injection_absent,
                 "The injection target remained absent.",
                 "The run did not prove the injection target stayed absent."),
        evidence("pending" in lower_response and "workspace:fixture-mini" in response and "audit" not in lower_response,
                 "The returned receipt was reported without claiming the audit ran in the launcher.",
                 "The receipt is incomplete or the launcher claimed to perform the audit."),
    ]


for item in EVALS:
    eval_dir = ROOT / f"eval-{item['id']}-{item['name']}"
    for configuration in ("with_skill", "without_skill"):
        run = eval_dir / configuration / "run-1"
        response = (run / "outputs" / "response.md").read_text()
        actions = json.loads((run / "outputs" / "actions.json").read_text())
        results = grade(item["id"], item["prompt"], response, actions)
        expectations = [
            {"text": text, **result}
            for text, result in zip(item["expectations"], results)
        ]
        passed = sum(result["passed"] for result in expectations)
        timing = json.loads((run / "timing.json").read_text())
        grading = {
            "expectations": expectations,
            "summary": {
                "passed": passed,
                "failed": len(expectations) - passed,
                "total": len(expectations),
                "pass_rate": passed / len(expectations),
            },
            "execution_metrics": {
                "tool_calls": {},
                "total_tool_calls": len(operations(actions)),
                "total_steps": len(operations(actions)),
                "errors_encountered": 0,
                "output_chars": len(response) + len(json.dumps(actions)),
                "transcript_chars": 0,
            },
            "timing": {
                "executor_duration_seconds": timing["total_duration_seconds"],
                "grader_duration_seconds": 0,
                "total_duration_seconds": timing["total_duration_seconds"],
            },
        }
        (run / "grading.json").write_text(json.dumps(grading, indent=2) + "\n")
