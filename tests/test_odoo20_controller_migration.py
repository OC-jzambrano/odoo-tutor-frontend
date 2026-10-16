import ast
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ODOO_TUTOR_DIR = os.path.join(BASE_DIR, "odoo_tutor")
CONTROLLERS_DIR = os.path.join(ODOO_TUTOR_DIR, "controllers")


class MockAccessDenied(Exception):
    """Simulates odoo.exceptions.AccessDenied"""



@pytest.fixture(scope="module")
def odoo_env_mocks():
    """Sets up a mock of the Odoo environment for controller testing."""
    mock_odoo = MagicMock()
    mock_odoo.__path__ = []
    mock_http = MagicMock()
    mock_http.__path__ = []
    mock_models = MagicMock()
    mock_fields = MagicMock()
    mock_tools = MagicMock()
    mock_api = MagicMock()
    mock_exceptions = MagicMock()
    mock_exceptions.AccessDenied = MockAccessDenied

    def mock_route(*args, **kwargs):
        def decorator(f):
            f.routing = kwargs
            f.routing_args = args
            return f

        return decorator

    mock_http.route = mock_route
    mock_http.Controller = object
    mock_odoo.http = mock_http
    mock_odoo.models = mock_models
    mock_odoo.fields = mock_fields
    mock_odoo.tools = mock_tools
    mock_odoo.api = mock_api
    mock_odoo.exceptions = mock_exceptions

    modules_to_patch = {
        "odoo": mock_odoo,
        "odoo.http": mock_http,
        "odoo.models": mock_models,
        "odoo.fields": mock_fields,
        "odoo.tools": mock_tools,
        "odoo.api": mock_api,
        "odoo.exceptions": mock_exceptions,
    }

    with patch.dict(sys.modules, modules_to_patch):
        if BASE_DIR not in sys.path:
            sys.path.insert(0, BASE_DIR)
        import odoo_tutor.controllers.ai_chat as ai_chat_mod
        import odoo_tutor.controllers.main as main_mod

        yield {
            "main_mod": main_mod,
            "ai_chat_mod": ai_chat_mod,
            "mock_http": mock_http,
        }


class TestRouteConfiguration:
    """Tests verifying controller route declarations for Odoo 20 compatibility."""

    def test_odoo_tutor_chat_route_is_jsonrpc(self, odoo_env_mocks):
        main_mod = odoo_env_mocks["main_mod"]
        handler = main_mod.OdooTutorController.tutor_chat
        routing = getattr(handler, "routing", {})

        assert routing.get("type") == "jsonrpc", (
            f"Expected type='jsonrpc', got '{routing.get('type')}'"
        )
        assert routing.get("auth") == "user", (
            f"Expected auth='user', got '{routing.get('auth')}'"
        )
        assert routing.get("methods") == ["POST"], (
            f"Expected methods=['POST'], got '{routing.get('methods')}'"
        )

    def test_ai_chat_routes_are_jsonrpc(self, odoo_env_mocks):
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]
        cls = ai_chat_mod.AiChatController

        expected_routes = {
            "ws_config": {"type": "jsonrpc", "auth": "user"},
            "get_quickboard_item": {
                "type": "jsonrpc",
                "auth": "user",
                "methods": ["POST"],
            },
            "validate_exercise": {"type": "jsonrpc", "auth": "user"},
            "ai_chat_feedback": {"type": "jsonrpc", "auth": "user"},
        }

        for method_name, expected in expected_routes.items():
            handler = getattr(cls, method_name, None)
            assert handler is not None, (
                f"Method {method_name} not found on AiChatController"
            )
            routing = getattr(handler, "routing", {})
            for key, expected_val in expected.items():
                assert routing.get(key) == expected_val, (
                    f"Route {method_name}: expected {key}={expected_val}, "
                    f"got {routing.get(key)}"
                )

    def test_no_legacy_json_routes_in_any_controller(self):
        """AST check across all controllers: zero type='json' remain."""
        legacy_declarations = []
        for root, _, files in os.walk(CONTROLLERS_DIR):
            for file in files:
                if not file.endswith(".py"):
                    continue
                file_path = os.path.join(root, file)
                with open(file_path, encoding="utf-8") as f:
                    content = f.read()

                tree = ast.parse(content, filename=file_path)
                for node in ast.walk(tree):
                    if isinstance(node, ast.FunctionDef):
                        for decorator in node.decorator_list:
                            if isinstance(decorator, ast.Call):
                                func_name = ""
                                if isinstance(decorator.func, ast.Attribute):
                                    func_name = decorator.func.attr
                                elif isinstance(decorator.func, ast.Name):
                                    func_name = decorator.func.id

                                if func_name == "route":
                                    for kw in decorator.keywords:
                                        if (
                                            kw.arg == "type"
                                            and isinstance(
                                                kw.value, ast.Constant
                                            )
                                            and kw.value.value == "json"
                                        ):
                                            legacy_declarations.append(
                                                f"{file}:{node.lineno} "
                                                f"def {node.name}()"
                                            )

        assert not legacy_declarations, (
            f"Found legacy type='json' routes: {legacy_declarations}"
        )


class TestOWLRequestAndResponse:
    """Simulates OWL RPC calls to the Odoo 20 JSON-RPC controller."""

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_authenticated_owl_request_reaches_controller(
        self, mock_post, odoo_env_mocks
    ):
        main_mod = odoo_env_mocks["main_mod"]
        controller = main_mod.OdooTutorController()

        mock_request = main_mod.request
        mock_request.session = MagicMock()
        mock_request.session.uid = 2

        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-mock-key-12345",
            "odoo_tutor.backend_url": "http://mockbackend:8001",
        }.get(key, default)

        mock_user = MagicMock()
        mock_user.id = 2
        mock_env = MagicMock()
        mock_env.__getitem__.side_effect = lambda k: {
            "ir.config_parameter": MagicMock(
                sudo=MagicMock(return_value=mock_params)
            ),
            "res.users": mock_user,
        }.get(k, MagicMock())
        mock_env.user = mock_user
        mock_request.env = mock_env

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": "Para registrar pago, presiona Registrar Pago.",
            "exercise_id": "exercise-42",
        }
        mock_post.return_value = mock_response

        # Odoo 20 unpacks JSON-RPC params into kwargs
        result = controller.tutor_chat(
            message="¿Cómo registro un pago?",
            context={"model": "account.move", "res_id": 10},
        )

        assert result.get("error") is not True
        assert "Registrar Pago" in result.get("response", "")
        assert result.get("exercise_id") == "exercise-42"

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_valid_request_returns_expected_format(
        self, mock_post, odoo_env_mocks
    ):
        main_mod = odoo_env_mocks["main_mod"]
        controller = main_mod.OdooTutorController()

        mock_request = main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-valid-key",
            "odoo_tutor.backend_url": "http://localhost:8001",
        }.get(key, default)
        mock_env = MagicMock()
        mock_env.__getitem__.side_effect = lambda k: {
            "ir.config_parameter": MagicMock(
                sudo=MagicMock(return_value=mock_params)
            )
        }.get(k, MagicMock())
        mock_request.env = mock_env

        backend_payload = {
            "response": "El inventario se valida automáticamente.",
            "copy_targets": ["validate_button"],
            "exercise_id": None,
        }
        mock_post.return_value = MagicMock(
            status_code=200, json=lambda: backend_payload
        )

        result = controller.tutor_chat(message="¿Cómo valido inventario?")

        assert isinstance(result, dict)
        assert result["response"] == "El inventario se valida automáticamente."
        assert result["copy_targets"] == ["validate_button"]
        assert result.get("error") is None or result.get("error") is False

    def test_unauthenticated_request_access_denied(self, odoo_env_mocks):
        """Verifies that routes with auth='user' enforce authentication."""
        main_mod = odoo_env_mocks["main_mod"]
        handler = main_mod.OdooTutorController.tutor_chat
        auth_type = handler.routing.get("auth")

        assert auth_type == "user"

        def simulate_odoo_auth_dispatch(routing_info, session_uid):
            if routing_info.get("auth") == "user" and not session_uid:
                raise MockAccessDenied(
                    "Access Denied: authentication required for auth='user'"
                )
            return True

        with pytest.raises(MockAccessDenied, match="authentication required"):
            simulate_odoo_auth_dispatch(handler.routing, session_uid=None)

        assert simulate_odoo_auth_dispatch(handler.routing, session_uid=2) is True


class TestModuleInstallationAndControllerRegistration:
    """Simulates Odoo 20's controller registration mechanism during module load."""

    def test_odoo20_controller_registration_validates_route_types(
        self, odoo_env_mocks
    ):
        """Odoo 20 permits {'http', 'jsonrpc'}; 'json' raises error."""
        odoo_20_allowed = {"http", "jsonrpc"}

        main_mod = odoo_env_mocks["main_mod"]
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]

        controllers = [
            main_mod.OdooTutorController,
            ai_chat_mod.AiChatController,
        ]

        registered_routes = []
        registration_errors = []

        for controller_cls in controllers:
            for attr_name in dir(controller_cls):
                method = getattr(controller_cls, attr_name)
                if callable(method) and hasattr(method, "routing"):
                    routing = method.routing
                    route_type = routing.get("type", "http")

                    if route_type not in odoo_20_allowed:
                        registration_errors.append(
                            f"Invalid route type '{route_type}' for "
                            f"{controller_cls.__name__}.{attr_name}."
                        )
                    else:
                        registered_routes.append(
                            (controller_cls.__name__, attr_name, route_type)
                        )

        assert len(registration_errors) == 0, (
            f"Registration errors: {registration_errors}"
        )
        assert len(registered_routes) >= 5, (
            "Expected all 5 controller routes to register successfully"
        )


class TestExistingControllerRoutesAfterMigration:
    """Verifies that existing controller routes in ai_chat.py work properly."""

    def test_ws_config_route(self, odoo_env_mocks):
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]
        controller = ai_chat_mod.AiChatController()

        mock_request = ai_chat_mod.request
        mock_params = MagicMock()
        mock_params.get_param.return_value = "ws://localhost:8001/ws"
        mock_request.env = {
            "ir.config_parameter": MagicMock(
                sudo=MagicMock(return_value=mock_params)
            )
        }

        res = controller.ws_config()
        assert isinstance(res, dict)
        assert "ws_base_url" in res
        assert "enable_skip_step" in res

    @patch("odoo_tutor.controllers.ai_chat.AiBot")
    def test_ai_chat_route_handles_jsonrpc_kwargs(
        self, mock_ai_bot, odoo_env_mocks
    ):
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]
        controller = ai_chat_mod.AiChatController()

        mock_bot_instance = MagicMock()
        mock_bot_instance._chat.return_value = {
            "response": "Respuesta simulada del bot"
        }
        mock_ai_bot.return_value = mock_bot_instance

        mock_request = ai_chat_mod.request
        mock_request.env = MagicMock()
        mock_request.httprequest = MagicMock()
        mock_request.httprequest.data = b""

        # In Odoo 20, JSON-RPC params arrive as method arguments
        result = controller.get_quickboard_item(
            message="Hola mundo",
            context={"model": "sale.order"},
            ws_session_id="session-123",
        )

        assert result == {"response": "Respuesta simulada del bot"}
        mock_bot_instance._chat.assert_called_once_with(
            message="Hola mundo", context={"model": "sale.order"}
        )

    def test_ai_chat_route_missing_message_validation(self, odoo_env_mocks):
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]
        controller = ai_chat_mod.AiChatController()

        mock_request = ai_chat_mod.request
        mock_request.env = MagicMock()
        mock_request.httprequest = MagicMock()
        mock_request.httprequest.data = b""

        result = controller.get_quickboard_item(message="", context={})
        assert "Error:" in str(result)
        assert "requerido" in str(result)

    @patch("odoo_tutor.controllers.ai_chat.requests.get")
    def test_validate_exercise_route_with_jsonrpc_kwargs(
        self, mock_get, odoo_env_mocks
    ):
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]
        controller = ai_chat_mod.AiChatController()

        mock_request = ai_chat_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.chatbot_session_token": "token-xyz",
            "odoo_tutor.chatbot_base_url": "http://chatbot:8001",
        }.get(key, default)
        mock_env = MagicMock()
        mock_env.__getitem__.side_effect = lambda key: {
            "ir.config_parameter": MagicMock(
                sudo=MagicMock(return_value=mock_params)
            )
        }.get(key, MagicMock())
        mock_env.cr = MagicMock()
        mock_env.cr.dbname = "test_db"
        mock_request.env = mock_env
        mock_request.httprequest = MagicMock()
        mock_request.httprequest.data = b""

        mock_response = MagicMock()
        mock_response.text = (
            '{"status": "success", "details": {"results": []}}'
        )
        mock_get.return_value = mock_response

        # Call with exercise_id as kwarg (Odoo 20 JSON-RPC)
        result = controller.validate_exercise(exercise_id="exercise_99")
        assert result == {"result": mock_response.text}

    def test_feedback_route_with_jsonrpc_kwargs(self, odoo_env_mocks):
        ai_chat_mod = odoo_env_mocks["ai_chat_mod"]
        controller = ai_chat_mod.AiChatController()

        mock_request = ai_chat_mod.request
        mock_feedback_model = MagicMock()
        mock_record = MagicMock()
        mock_record.id = 55
        mock_feedback_model.sudo.return_value.create.return_value = mock_record

        mock_user = MagicMock()
        mock_user.id = 1
        mock_env = MagicMock()
        mock_env.__getitem__.side_effect = lambda key: {
            "ai.chat.feedback": mock_feedback_model,
        }.get(key, MagicMock())
        mock_env.user = mock_user
        mock_request.env = mock_env

        result = controller.ai_chat_feedback(
            message_uid="msg_123",
            vote=1,
            comment="Gran explicación!",
            context={"model": "sale.order", "res_id": 4},
        )

        assert result == {"id": 55}
        mock_feedback_model.sudo.return_value.create.assert_called_once()
        create_args = mock_feedback_model.sudo.return_value.create.call_args[0][
            0
        ]
        assert create_args["message_uid"] == "msg_123"
        assert create_args["vote"] == 1
        assert create_args["comment"] == "Gran explicación!"
