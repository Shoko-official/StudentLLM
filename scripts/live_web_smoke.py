"""Inspect and smoke-test the already running StudentLLM web interface."""

import sys

from playwright.sync_api import sync_playwright


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto("http://127.0.0.1:5173/", wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        print(f"URL={page.url}")
        print(f"TITLE={page.title()}")
        print(f"BODY_TEXT={page.locator('body').inner_text()[:500]}")
        print("BUTTONS=" + " | ".join(page.get_by_role("button").all_inner_texts()))
        print("INPUTS=" + str(page.locator("input").count()))
        print("TEXTAREAS=" + str(page.locator("textarea").count()))
        page.get_by_role("button", name="New course", exact=True).click()
        dialog = page.get_by_role("dialog", name="Start a course", exact=True)
        dialog.wait_for(state="visible", timeout=5_000)
        if dialog.count() != 1 or not dialog.is_visible():
            raise AssertionError("The new-course dialog did not open")
        print("AFTER_NEW_COURSE=" + page.locator("body").inner_text()[-400:])
        page.keyboard.press("Escape")
        dialog.wait_for(state="hidden", timeout=5_000)
        if dialog.count() != 0:
            raise AssertionError("Escape did not close the new-course dialog")

        page.get_by_role("button", name="Settings", exact=True).click()
        settings = page.get_by_role("dialog", name="Settings", exact=True)
        settings.wait_for(state="visible", timeout=5_000)
        settings.get_by_label("LM Studio address", exact=True).fill("/lm-studio/v1")
        settings.get_by_label("Model", exact=True).fill("openai/gpt-oss-20b")
        settings.get_by_role("button", name="Save connections", exact=True).click()
        settings.get_by_text("LM Studio: Connected. Selected model is available.", exact=True).wait_for(state="visible", timeout=10_000)
        settings.get_by_role("button", name="Done", exact=True).click()
        settings.wait_for(state="hidden", timeout=5_000)

        page.get_by_role("button", name="Quick start", exact=True).click()
        quick_start = page.get_by_role("dialog", name="Quick start", exact=True)
        quick_start.wait_for(state="visible", timeout=5_000)
        quick_start.get_by_label("Lecture excerpt or course description", exact=True).fill(
            "This lecture introduces eigenvalues and eigenvectors. "
            "We compute the characteristic polynomial of a matrix and interpret its roots."
        )
        quick_start.get_by_role("button", name="Analyze structure", exact=True).click()
        try:
            quick_start.get_by_text("confidence", exact=False).wait_for(state="visible", timeout=30_000)
        except Exception:
            print("LIVE_QUICK_START_STATE=" + quick_start.inner_text().replace("\n", " | ")[:1_000])
            raise
        for field in ("Course group", "Subject", "Lesson", "Title"):
            value = quick_start.get_by_label(field, exact=True).get_attribute("value")
            if not value or not value.strip():
                raise AssertionError(f"Live Quick Start returned an empty {field} field")
        proposal_text = quick_start.inner_text()
        print("LIVE_QUICK_START=" + proposal_text.replace("\n", " | ")[:600])
        if "confidence" not in proposal_text.lower():
            raise AssertionError("Live Quick Start did not expose a confidence summary")
        page.keyboard.press("Escape")
        quick_start.wait_for(state="hidden", timeout=5_000)
        if quick_start.count() != 0:
            raise AssertionError("Escape did not close the live Quick Start dialog")
        print("DIALOGS_AFTER_ESCAPE=0")
        print("ERRORS=" + " | ".join(errors))
        if errors:
            raise AssertionError("The page emitted browser errors")
        browser.close()


if __name__ == "__main__":
    main()
