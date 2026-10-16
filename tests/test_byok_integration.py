import ast
import os
import sys
import xml.etree.ElementTree as ET
from unittest.mock import MagicMock, patch
import pytest
import requests

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ODOO_TUTOR_DIR = os.path.join(BASE_DIR, "odoo_tutor")


class TestManifestAndAssets:
    def test_manifest_structure_and_files(self):
        manifest_path = os.path.join(ODOO_TUTOR_DIR, "__manifest__.py")
        assert os.path.exists(manifest_path), "__manifest__.py must exist"

        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest_data = ast.literal_eval(f.read())

        # Mandatory metadata for apps.odoo.com
        required_keys = ["name", "version", "category", "summary", "author", "license", "depends", "data", "assets"]
        for key in required_keys:
            assert key in manifest_data, f"Missing key in __manifest__.py: {key}"

        # Verify depends
        assert "base" in manifest_data["depends"]
        assert "web" in manifest_data["depends"]

        # Verify all files listed in 'data' exist
        for rel_path in manifest_data["data"]:
            abs_path = os.path.join(ODOO_TUTOR_DIR, rel_path)
            assert os.path.exists(abs_path), f"Data file {rel_path} declared in manifest does not exist on disk"

        # Verify description files
        icon_path = os.path.join(ODOO_TUTOR_DIR, "static", "description", "icon.png")
        index_path = os.path.join(ODOO_TUTOR_DIR, "static", "description", "index.html")
        assert os.path.exists(icon_path), "static/description/icon.png must exist"
        assert os.path.exists(index_path), "static/description/index.html must exist"


class TestXMLViews:
    def test_res_config_settings_view_xml_validity(self):
        xml_path = os.path.join(ODOO_TUTOR_DIR, "views", "res_config_settings_views.xml")
        tree = ET.parse(xml_path)
        root = tree.getroot()
        assert root.tag == "odoo"

        record = root.find("record")
        assert record is not None
        assert record.get("id") == "res_config_settings_view_form_odoo_tutor"

        # Check arch contains the BYOK fields
        arch_str = ET.tostring(record, encoding="unicode")
        assert "odoo_tutor_openai_key" in arch_str
        assert "odoo_tutor_backend_url" in arch_str
        assert "odoo_tutor_setting_container" in arch_str

    def test_menus_view_xml_validity(self):
        xml_path = os.path.join(ODOO_TUTOR_DIR, "views", "odoo_tutor_menus.xml")
        tree = ET.parse(xml_path)
        root = tree.getroot()
        assert root.tag == "odoo"
        menu = root.find("menuitem")
        assert menu is not None
        assert menu.get("id") == "menu_odoo_tutor_root"


class TestControllerProxy:
    @pytest.fixture(autouse=True)
    def setup_odoo_mocks(self):
        # Create mock odoo module hierarchy in sys.modules
        mock_odoo = MagicMock()
        mock_odoo.__path__ = []
        mock_http = MagicMock()
        mock_http.__path__ = []
        mock_models = MagicMock()
        mock_fields = MagicMock()
        mock_tools = MagicMock()
        mock_api = MagicMock()

        def mock_route(*args, **kwargs):
            def decorator(f):
                f.routing = kwargs
                return f
            return decorator

        mock_http.route = mock_route
        mock_http.Controller = object
        mock_odoo.http = mock_http
        mock_odoo.models = mock_models
        mock_odoo.fields = mock_fields
        mock_odoo.tools = mock_tools
        mock_odoo.api = mock_api

        with patch.dict(sys.modules, {
            "odoo": mock_odoo,
            "odoo.http": mock_http,
            "odoo.models": mock_models,
            "odoo.fields": mock_fields,
            "odoo.tools": mock_tools,
            "odoo.api": mock_api,
        }):
            sys.path.insert(0, BASE_DIR)
            import odoo_tutor.controllers.main as main_mod
            self.controller_class = main_mod.OdooTutorController
            self.main_mod = main_mod
            yield

    def test_chat_without_api_key(self):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: (
            None if key == "odoo_tutor.openai_key" else default
        )
        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {}

        result = controller.tutor_chat(message="Hola tutor", context={"model": "sale.order"})
        assert result.get("error") is True
        assert "Configura primero tu OpenAI API Key" in result.get("response", "")

    def test_chat_empty_message(self):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_request.params = {}

        result = controller.tutor_chat(message="   ", context={"model": "sale.order"})
        assert result.get("error") is True
        assert "no puede estar vacío" in result.get("response", "")

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_success_proxy_with_contract(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-user-openai-key-abc",
            "odoo_tutor.backend_url": "http://testserver:8001",
            "odoo_tutor.chatbot_api_key": "backend-secret-xyz",
        }.get(key, default)

        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {}

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "response": "Respuesta desde el tutor de IA",
            "exercise_id": None,
        }
        mock_post.return_value = mock_response

        context = {"model": "sale.order", "res_id": 10}
        result = controller.tutor_chat(message="¿Cómo confirmo una cotización?", context=context)

        assert result["response"] == "Respuesta desde el tutor de IA"
        mock_post.assert_called_once_with(
            "http://testserver:8001/chat",
            json={
                "message": "¿Cómo confirmo una cotización?",
                "context": {"model": "sale.order", "res_id": 10},
            },
            headers={
                "Content-Type": "application/json",
                "X-OpenAI-Key": "sk-user-openai-key-abc",
                "X-API-Key": "backend-secret-xyz",
            },
            timeout=30
        )

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_fallback_context_model(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-user-openai-key-abc",
            "odoo_tutor.backend_url": "http://testserver:8001",
            "odoo_tutor.chatbot_api_key": "backend-secret-xyz",
        }.get(key, default)

        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {"model": "crm.lead"}

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "OK"}
        mock_post.return_value = mock_response

        # Call without context
        controller.tutor_chat(message="Test question")

        called_payload = mock_post.call_args[1]["json"]
        assert called_payload["context"]["model"] == "crm.lead"

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_backend_auth_rejection(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-user-openai-key-abc",
            "odoo_tutor.backend_url": "http://testserver:8001",
            "odoo_tutor.chatbot_api_key": "wrong-secret",
        }.get(key, default)

        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {}

        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.json.return_value = {"detail": "Invalid or missing API key"}
        mock_response.text = '{"detail": "Invalid or missing API key"}'
        mock_post.return_value = mock_response

        result = controller.tutor_chat(message="test", context={"model": "sale.order"})
        assert result.get("error") is True
        assert "Error de autenticación con el backend" in result.get("response", "")

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_backend_validation_rejection(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-user-openai-key-abc",
            "odoo_tutor.backend_url": "http://testserver:8001",
            "odoo_tutor.chatbot_api_key": "backend-secret-xyz",
        }.get(key, default)

        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {}

        mock_response = MagicMock()
        mock_response.status_code = 422
        mock_response.json.return_value = {"detail": "Unprocessable Entity"}
        mock_response.text = '{"detail": "Unprocessable Entity"}'
        mock_post.return_value = mock_response

        result = controller.tutor_chat(message="test", context={"model": "sale.order"})
        assert result.get("error") is True
        assert "Error de validación" in result.get("response", "")

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_connection_exception(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-user-openai-key-abc",
            "odoo_tutor.backend_url": "http://testserver:8001",
            "odoo_tutor.chatbot_api_key": "backend-secret-xyz",
        }.get(key, default)

        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {}

        mock_post.side_effect = requests.RequestException("Connection refused")

        result = controller.tutor_chat(message="test", context={"model": "sale.order"})
        assert result.get("error") is True
        assert "No se pudo conectar" in result.get("response", "")


class TestEndToEndChain:
    """
    Simulates the complete chain:
    Client -> Odoo Proxy Controller -> FastAPI App (ms_ai) -> Mocked OpenAI LLM
    """
    @pytest.fixture(autouse=True)
    def setup_chain(self):
        backend_dir = r"C:\Users\LENOVO\dev\odoo-tutor-backend"
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)

        # Mock odoo
        mock_odoo = MagicMock()
        mock_odoo.__path__ = []
        mock_http = MagicMock()
        mock_http.__path__ = []
        mock_models = MagicMock()
        mock_fields = MagicMock()
        mock_tools = MagicMock()
        mock_api = MagicMock()

        def mock_route(*args, **kwargs):
            def decorator(f):
                f.routing = kwargs
                return f
            return decorator

        mock_http.route = mock_route
        mock_http.Controller = object
        mock_odoo.http = mock_http
        mock_odoo.models = mock_models
        mock_odoo.fields = mock_fields
        mock_odoo.tools = mock_tools
        mock_odoo.api = mock_api

        with patch.dict(sys.modules, {
            "odoo": mock_odoo,
            "odoo.http": mock_http,
            "odoo.models": mock_models,
            "odoo.fields": mock_fields,
            "odoo.tools": mock_tools,
            "odoo.api": mock_api,
        }):
            import odoo_tutor.controllers.main as main_mod
            from ms_ai.app.main import app as fastapi_app
            from fastapi.testclient import TestClient

            self.main_mod = main_mod
            self.fastapi_client = TestClient(fastapi_app)
            self.controller = main_mod.OdooTutorController()
            yield

    @patch("ms_ai.app.main.ChatOpenAI")
    def test_complete_e2e_request_chain(self, mock_chat_openai):
        # 1. Mock OpenAI
        mock_llm_instance = MagicMock()
        mock_llm_response = MagicMock()
        mock_llm_response.content = "Para confirmar el pedido en sale.order, haz clic en Confirmar."
        mock_llm_instance.invoke.return_value = mock_llm_response
        mock_chat_openai.return_value = mock_llm_instance

        # 2. Configure Odoo ir.config_parameter
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: {
            "odoo_tutor.openai_key": "sk-customer-test-key",
            "odoo_tutor.backend_url": "http://fastapi-test",
            "odoo_tutor.chatbot_api_key": "your-super-secret-key-123",
        }.get(key, default)
        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}
        mock_request.params = {}

        # 3. Intercept requests.post in controller and pipe directly to fastapi_client
        def simulated_network_post(url, json=None, headers=None, timeout=None):
            path = url.replace("http://fastapi-test", "")
            fastapi_res = self.fastapi_client.post(path, json=json, headers=headers)
            # Create a mock requests.Response matching the FastAPI TestClient response
            resp = requests.Response()
            resp.status_code = fastapi_res.status_code
            resp._content = fastapi_res.content
            resp.headers = fastapi_res.headers
            return resp

        with patch("odoo_tutor.controllers.main.requests.post", side_effect=simulated_network_post):
            # 4. User invokes tutor_chat from Odoo OWL sidebar
            result = self.controller.tutor_chat(
                message="¿Cómo confirmo un pedido de venta?",
                context={"model": "sale.order", "res_id": 42}
            )

        # 5. Verify the full chain outcome
        assert result.get("error") is None or result.get("error") is False
        assert result.get("response") == "Para confirmar el pedido en sale.order, haz clic en Confirmar."

        # Verify ChatOpenAI was instantiated with customer's key
        mock_chat_openai.assert_called_once_with(
            model="gpt-4o-2024-11-20",
            api_key="sk-customer-test-key"
        )
