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
        mock_params.get_param.side_effect = lambda key, default=None: None if key == "odoo_tutor.openai_key" else "http://localhost:8001"
        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}

        result = controller.tutor_chat(message="Hola tutor")
        assert result.get("error") is True
        assert "Configura primero tu OpenAI API Key" in result.get("response", "")

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_success_proxy(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: (
            "sk-user-openai-key-abc" if key == "odoo_tutor.openai_key"
            else "http://testserver:8001"
        )
        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"response": "Respuesta desde el tutor de IA"}
        mock_post.return_value = mock_response

        result = controller.tutor_chat(message="¿Cómo confirmo una cotización?")

        assert result == {"response": "Respuesta desde el tutor de IA"}
        mock_post.assert_called_once_with(
            "http://testserver:8001/chat",
            json={"message": "¿Cómo confirmo una cotización?"},
            headers={
                "Content-Type": "application/json",
                "X-OpenAI-Key": "sk-user-openai-key-abc",
            },
            timeout=30
        )

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_backend_error_response(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: (
            "sk-user-openai-key-abc" if key == "odoo_tutor.openai_key"
            else "http://testserver:8001"
        )
        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Model Error"
        mock_post.return_value = mock_response

        result = controller.tutor_chat(message="test")
        assert result.get("error") is True
        assert "500" in result.get("response", "")

    @patch("odoo_tutor.controllers.main.requests.post")
    def test_chat_connection_exception(self, mock_post):
        controller = self.controller_class()
        mock_request = self.main_mod.request
        mock_params = MagicMock()
        mock_params.get_param.side_effect = lambda key, default=None: (
            "sk-user-openai-key-abc" if key == "odoo_tutor.openai_key"
            else "http://testserver:8001"
        )
        mock_request.env = {"ir.config_parameter": MagicMock(sudo=MagicMock(return_value=mock_params))}

        mock_post.side_effect = requests.RequestException("Connection refused")

        result = controller.tutor_chat(message="test")
        assert result.get("error") is True
        assert "No se pudo conectar" in result.get("response", "")
