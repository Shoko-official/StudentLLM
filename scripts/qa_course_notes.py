from playwright.sync_api import sync_playwright


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.goto("http://127.0.0.1:5173/", wait_until="networkidle")
        note = page.get_by_role("region", name="Course notes document")
        assert note.is_visible(), "course note document is not visible"
        note_text = " ".join(note.inner_text().split())
        assert "Attention & Scaled Dot-Product" in note_text
        assert "Courses / Machine Learning / Transformers" in note_text
        assert "structured blocks" in note_text
        with page.expect_download() as download_info:
            note.get_by_role("button", name="Save note").click()
        download = download_info.value
        assert download.suggested_filename.endswith("-course-notes.md")
        page.screenshot(path="artifacts/qa/course-notes.png", full_page=True)
        print(f"course_note_visible=true filename={download.suggested_filename}")
        print("screenshot=artifacts/qa/course-notes.png")
        browser.close()


if __name__ == "__main__":
    main()
