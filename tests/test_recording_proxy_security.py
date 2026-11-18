"""Security and permission checks for Odoo recording draft proxy endpoints."""

from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_recording_security_groups_registered_in_manifest():
    manifest = (ROOT / "odoo_mentor/__manifest__.py").read_text(encoding="utf-8")
    security_xml = (ROOT / "odoo_mentor/security/odoo_tutor_security.xml").read_text(
        encoding="utf-8"
    )

    assert '"security/odoo_tutor_security.xml"' in manifest
    assert 'id="group_odoo_tutor_expert"' in security_xml
    assert 'id="group_odoo_tutor_reviewer"' in security_xml
    assert 'id="base.group_system"' in security_xml


def test_recording_proxy_checks_permissions_and_derives_server_identity():
    controller = (ROOT / "odoo_mentor/controllers/ai_chat.py").read_text(
        encoding="utf-8"
    )
    proxy_section = controller.split("def _recording_proxy_context", 1)[1]

    assert "request.env.user.has_group(required_group)" in proxy_section
    assert '"X-Odoo-Database": request.env.cr.dbname' in proxy_section
    assert '"X-Odoo-User-Id": str(request.env.user.id)' in proxy_section
    assert '"Authorization": "Bearer " + credential' in proxy_section
    assert "odoo_mentor.group_odoo_tutor_expert" in proxy_section
    assert "odoo_mentor.group_odoo_tutor_reviewer" in proxy_section
    assert "installation_credential" in proxy_section
    assert 'return {"ok": True, "data": body}' in proxy_section


def test_recorder_excludes_credential_and_raw_input_capture():
    recorder = (ROOT / "odoo_mentor/static/src/core/ai_recorder.js").read_text(
        encoding="utf-8"
    )
    assert "isSensitiveInputElement" in recorder
    assert "isRecorderUiElement" in recorder
    assert "value_preview" not in recorder
    assert "value: null" in recorder
