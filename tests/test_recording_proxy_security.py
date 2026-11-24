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
    assert "/ai_chat/recording_drafts/polish" in proxy_section
    assert "def polish_recording_draft_proxy" in proxy_section
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


def test_recorder_does_not_call_llm_per_step_during_recording():
    recorder = (ROOT / "odoo_mentor/static/src/core/ai_recorder.js").read_text(
        encoding="utf-8"
    )
    assert "/ai_chat/recording_drafts/polish" not in recorder
    assert "polish" not in recorder.lower()


def test_polish_proxy_checks_permissions_and_sanitizes_batched_steps():
    controller = (ROOT / "odoo_mentor/controllers/ai_chat.py").read_text(
        encoding="utf-8"
    )
    assert '/ai_chat/recording_drafts/polish' in controller
    polish_route = controller.split("def polish_recording_draft_proxy", 1)[1].split(
        "@http.route", 1
    )[0]
    assert 'self._recording_proxy_context("odoo_mentor.group_odoo_tutor_expert")' in polish_route
    assert 'f"{base_path}/polish"' in polish_route
    assert "allow_redirects=False" in polish_route
    assert '"value"' not in polish_route


def test_review_decision_and_publish_proxies_use_extended_timeout_and_reviewer_group():
    controller = (ROOT / "odoo_mentor/controllers/ai_chat.py").read_text(
        encoding="utf-8"
    )
    decision_route = controller.split("def review_draft_decision_proxy", 1)[1].split(
        "@http.route", 1
    )[0]
    assert 'self._recording_proxy_context("odoo_mentor.group_odoo_tutor_reviewer")' in decision_route
    assert "timeout=(3, 25)" in decision_route
    assert "allow_redirects=False" in decision_route

    assert "/ai_chat/recording_drafts/review_publish" in controller
    publish_route = controller.split("def review_draft_publish_proxy", 1)[1]
    assert 'self._recording_proxy_context("odoo_mentor.group_odoo_tutor_reviewer")' in publish_route
    assert 'f"{base_path}/review/{safe_id}/publish"' in publish_route
    assert "timeout=(3, 25)" in publish_route
    assert "allow_redirects=False" in publish_route


def test_save_draft_proxy_has_extra_field_422_fallback():
    controller = (ROOT / "odoo_mentor/controllers/ai_chat.py").read_text(
        encoding="utf-8"
    )
    save_route = controller.split("def save_recording_draft_proxy", 1)[1].split(
        "@http.route", 1
    )[0]
    assert "response.status_code == 422" in save_route
    assert "_strip_rejected_draft_step_fields" in save_route
