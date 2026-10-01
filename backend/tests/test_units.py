"""Unit tests for settings, the database factory, workflow functions, and the fake model script."""

from __future__ import annotations

import pytest
from agno.db.postgres import PostgresDb
from agno.db.sqlite import SqliteDb
from agno.workflow import StepInput

from app.db import create_db
from app.functions import extract_json, extract_urls
from app.settings import DEFAULT_MODEL_ID, Settings, _split_csv, build_model
from tests.fake_llm import plan_reply


class TestSettings:
    def test_defaults_when_env_is_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("RUNTIME_ENV", "OPENROUTER_MODEL_ID", "DATABASE_URL", "OS_SECURITY_KEY", "CORS_ORIGINS"):
            monkeypatch.delenv(name, raising=False)
        settings = Settings.from_env()
        assert settings.runtime_env == "prd"
        assert settings.model_id == DEFAULT_MODEL_ID
        assert settings.database_url.startswith("sqlite")
        assert settings.cors_origins == []

    def test_split_csv_trims_and_drops_blanks(self) -> None:
        assert _split_csv(" http://a.com, ,http://b.com ") == ["http://a.com", "http://b.com"]
        assert _split_csv(None) == []

    def test_production_requires_secrets(self) -> None:
        with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY, OS_SECURITY_KEY"):
            Settings(runtime_env="prd").validate()

    def test_production_with_secrets_and_dev_without_pass(self) -> None:
        Settings(runtime_env="prd", openrouter_api_key="k", os_security_key="s").validate()
        Settings(runtime_env="dev").validate()

    def test_resilience_settings_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OPENROUTER_MAX_RETRIES", "5")
        monkeypatch.setenv("OPENROUTER_TIMEOUT", "30")
        monkeypatch.setenv("OPENROUTER_FALLBACK_MODELS", "openai/gpt-4o, deepseek/deepseek-chat")
        settings = Settings.from_env()
        assert (settings.max_retries, settings.timeout_seconds) == (5, 30.0)
        assert settings.fallback_models == ["openai/gpt-4o", "deepseek/deepseek-chat"]

    def test_several_workers_need_redis_in_production(self) -> None:
        with pytest.raises(RuntimeError, match="REDIS_URL"):
            Settings(runtime_env="prd", openrouter_api_key="k", os_security_key="s", web_concurrency=2).validate()
        Settings(
            runtime_env="prd", openrouter_api_key="k", os_security_key="s", web_concurrency=2, redis_url="redis://r"
        ).validate()

    def test_build_model_points_at_configured_endpoint(self, fake_llm: str) -> None:
        model = build_model("openai/gpt-4o")
        assert model.id == "openai/gpt-4o"
        assert model.base_url == fake_llm
        assert model.provider == "OpenRouter"
        # Transient failures are retried by the OpenAI SDK; every call has a timeout.
        assert model.max_retries == 3
        assert model.timeout == 120.0


class TestEventStream:
    def test_in_memory_by_default_and_redis_when_configured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from agno.os.event_streams.redis import RedisEventStream
        from agno.run import cancel
        from agno.run.cancellation_management.redis_cancellation_manager import RedisRunCancellationManager

        from app.main import use_redis

        assert use_redis(None) is None
        # Keep the process-wide cancellation manager untouched for the other tests.
        monkeypatch.setattr(cancel, "_cancellation_manager", cancel.get_cancellation_manager())
        monkeypatch.setattr(cancel, "_cancellation_manager_explicitly_set", cancel._cancellation_manager_explicitly_set)
        assert isinstance(use_redis("redis://localhost:6379/0"), RedisEventStream)
        assert isinstance(cancel.get_cancellation_manager(), RedisRunCancellationManager)


class TestDatabase:
    def test_sqlite_url_creates_sqlite_db(self, tmp_path) -> None:  # type: ignore[no-untyped-def]
        db = create_db(f"sqlite:///{tmp_path}/nested/x.db")
        assert isinstance(db, SqliteDb)
        assert (tmp_path / "nested").is_dir()

    def test_postgres_url_creates_postgres_db(self) -> None:
        assert isinstance(create_db("postgresql+psycopg://u:p@localhost:5432/db"), PostgresDb)


class TestFunctions:
    def test_extract_json_picks_largest_payload(self) -> None:
        text = 'See [1]. Result: {"rows": [1, 2, 3]} done'
        assert '"rows"' in extract_json(StepInput(previous_step_content=text))

    def test_extract_json_errors_and_passes_errors_through(self) -> None:
        assert extract_json(StepInput(previous_step_content="no json")).startswith("Error: ")
        assert extract_json(StepInput(previous_step_content="Error: upstream")) == "Error: upstream"

    def test_extract_urls_dedupes_in_order(self) -> None:
        text = "a https://x.com/a, b https://y.com. again https://x.com/a"
        assert extract_urls(StepInput(previous_step_content=text)) == "https://x.com/a\nhttps://y.com"

    def test_extract_urls_falls_back_to_workflow_input(self) -> None:
        assert extract_urls(StepInput(input="go to https://z.dev")) == "https://z.dev"
        assert extract_urls(StepInput(input="nothing")).startswith("Error: ")


class TestFakeModelScript:
    def test_build_calls_create_agent_only_when_offered(self) -> None:
        offered = {
            "messages": [{"role": "user", "content": "BUILD: Bot"}],
            "tools": [{"function": {"name": "create_agent"}}],
        }
        assert plan_reply(offered)["tool_call"]["arguments"]["name"] == "Bot"
        assert plan_reply({"messages": [{"role": "user", "content": "BUILD: Bot"}]}) == {"content": "Echo: BUILD: Bot"}

    def test_ui_form_prompt_names_the_agent(self) -> None:
        body = {
            "messages": [{"role": "user", "content": 'Build and publish a new agent named "Scout".\nPurpose: x'}],
            "tools": [{"function": {"name": "create_agent"}}],
        }
        assert plan_reply(body)["tool_call"]["arguments"]["name"] == "Scout"
        with_tools = (
            'Build and publish a new agent named "Op".\nPurpose: x\nGive it these registry tools: computer, calculator.'
        )
        args = plan_reply({**body, "messages": [{"role": "user", "content": with_tools}]})["tool_call"]["arguments"]
        assert args["tool_names"] == ["computer", "calculator"]

    def test_ui_form_prompts_for_teams_and_workflows(self) -> None:
        team = (
            'Build and publish a new team named "Desk".\nPurpose: p\n'
            "Members (exact agent ids): writer, critic. The team leader delegates to them."
        )
        offered = [{"function": {"name": "create_team"}}, {"function": {"name": "create_workflow"}}]
        call = plan_reply({"messages": [{"role": "user", "content": team}], "tools": offered})["tool_call"]
        assert call["name"] == "create_team" and call["arguments"]["member_ids"] == ["writer", "critic"]
        flow = 'Build and publish a new workflow named "P".\nSteps in order (exact agent ids, one step each): a, b.'
        call = plan_reply({"messages": [{"role": "user", "content": flow}], "tools": offered})["tool_call"]
        assert [step["agent_id"] for step in call["arguments"]["steps"]] == ["a", "b"]

    def test_archive_calls_the_gated_tool(self) -> None:
        body = {
            "messages": [{"role": "user", "content": "ARCHIVE: scout"}],
            "tools": [{"function": {"name": "archive_component"}}],
        }
        assert plan_reply(body)["tool_call"] == {"name": "archive_component", "arguments": {"component_id": "scout"}}

    def test_tool_result_is_acknowledged(self) -> None:
        assert plan_reply({"messages": [{"role": "tool", "content": "ok"}]}) == {"content": "published: ok"}
