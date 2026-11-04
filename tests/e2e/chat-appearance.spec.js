const { test, expect } = require("@playwright/test");

test("chat fills the sidebar and centers the tutor logo on desktop and mobile", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/odoo/crm?debug=assets");
    await expect(page.locator(".ai-owl-trigger")).toBeVisible();
    await page.locator("[data-ai-sidebar-toggle]").click();
    await expect(page.locator("#offcanvasAiSidebar")).toHaveClass(/show/);

    const styles = await page.evaluate(() => {
      const body = document.querySelector(
        "#offcanvasAiSidebar .offcanvas-body",
      );
      const chat = document.querySelector("#chat-ui-container");
      const room = chat.querySelector(".nlux-chatRoom-container");
      const avatar = chat.querySelector(".nlux-comp-avatarPicture");
      const bodyBox = body.getBoundingClientRect();
      const chatBox = chat.getBoundingClientRect();
      const roomBox = room.getBoundingClientRect();
      const sidebarWidth = document
        .querySelector("#offcanvasAiSidebar")
        .getBoundingClientRect().width;

      return {
        bodyPadding: getComputedStyle(body).padding,
        roomPadding: getComputedStyle(
          chat.querySelector(".nlux-AiChat-root"),
        ).getPropertyValue("--nlux-ChatRoom--Padding").trim(),
        roomBorder: getComputedStyle(room).borderTopWidth,
        roomRadius: getComputedStyle(room).borderTopLeftRadius,
        roomShadow: getComputedStyle(room).boxShadow,
        avatarPosition: getComputedStyle(avatar).backgroundPosition,
        sidebarWidth,
        aligned:
          Math.abs(bodyBox.left - chatBox.left) < 1 &&
          Math.abs(bodyBox.right - chatBox.right) < 1 &&
          Math.abs(chatBox.left - roomBox.left) < 1 &&
          Math.abs(chatBox.right - roomBox.right) < 1,
      };
    });

    expect(styles.bodyPadding).toBe("0px");
    expect(styles.roomPadding).toBe("0px");
    expect(styles.roomBorder).toBe("0px");
    expect(styles.roomRadius).toBe("0px");
    expect(styles.roomShadow).toBe("none");
    expect(styles.avatarPosition).toContain("50%");
    expect(styles.sidebarWidth).toBeLessThanOrEqual(500);
    expect(styles.aligned).toBe(true);
  }
});
