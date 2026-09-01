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
        page.get_by_text("New course", exact=True).click()
        page.wait_for_timeout(200)
        dialog_action = page.get_by_text("Create and prepare recording", exact=True)
        if dialog_action.count() != 1:
            raise AssertionError("The new-course dialog did not open")
        print("AFTER_NEW_COURSE=" + page.locator("body").inner_text()[-400:])
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        if dialog_action.count() != 0:
            raise AssertionError("Escape did not close the new-course dialog")
        print("DIALOGS_AFTER_ESCAPE=0")
        print("ERRORS=" + " | ".join(errors))
        if errors:
            raise AssertionError("The page emitted browser errors")
        browser.close()


if __name__ == "__main__":
    main()
