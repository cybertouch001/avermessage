package bot.tab.sites.avermessage;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class FileNameTest {
    @Test
    public void utf8FilenameStarWins() {
        assertEquals("रिपोर्ट 1.pdf",
            MainActivity.fileName("https://avermessage.sites.tab.bot/api/files/1?download=1",
                "attachment; filename=\"report.pdf\"; filename*=UTF-8''%E0%A4%B0%E0%A4%BF%E0%A4%AA%E0%A5%8B%E0%A4%B0%E0%A5%8D%E0%A4%9F%201.pdf",
                "application/pdf"));
    }

    @Test
    public void quotedFilename() {
        assertEquals("photo 2.jpg",
            MainActivity.fileName("https://x/api/files/2?download=1", "attachment; filename=\"photo 2.jpg\"", "image/jpeg"));
    }

    @Test
    public void unsafeCharactersReplaced() {
        assertEquals("a_b_c.txt", MainActivity.fileName("https://x/f", "attachment; filename=\"a/b:c.txt\"", "text/plain"));
    }
}
