# Twitch Chat TTS — Portable Windows

อ่านแชท Twitch แบบ realtime แล้วแปลงเป็นเสียงผ่าน **TokenMe API**

## วิธีใช้
1. แตก zip
2. เปิดโฟลเดอร์ `TwitchChatTTS-win32-x64`
3. ดับเบิลคลิก `TwitchChatTTS.exe`
4. วาง **TokenMe API Key** ในช่อง API Key
5. ใส่ชื่อช่อง Twitch → เชื่อมต่อ

แอปเปิด proxy ในเครื่องให้อัตโนมัติ (ไม่ต้องติดตั้ง Python)

ค่าเริ่มต้น model=`paxa/paxa-tts-flash-v2` · voice=`mocha`

## หมายเหตุ
- ต้องมีเน็ต (Twitch chat + TokenMe)
- API Key เก็บใน localStorage ของแอปบนเครื่องคุณเท่านั้น ไม่ถูก hardcode
- Windows Defender / SmartScreen อาจเตือนเพราะยังไม่เซ็นชื่อ → More info → Run anyway

สร้างสำหรับ Watchara


## อัปเดตอัตโนมัติ (GitHub Releases)

แอปเช็คเวอร์ชันจาก GitHub Releases ของ repo สาธารณะ
[`watcharah/twitch-tts-tokenme`](https://github.com/watcharah/twitch-tts-tokenme)

### วิธีปล่อยเวอร์ชันใหม่
1. อัป `version` ใน `package.json` (เช่น `1.2.1`)
2. Build portable:
   ```
   npx electron-packager . TwitchChatTTS --platform=win32 --arch=x64 --out=dist --overwrite --icon=build/icon.ico --ignore="(^|/)\.git($|/)|(^|/)dist($|/)"
   ```
3. Zip โฟลเดอร์ `dist/TwitchChatTTS-win32-x64` เป็นชื่อไฟล์**ตรงนี้เท่านั้น**:
   `TwitchChatTTS-windows-portable.zip`
4. สร้าง GitHub Release แท็ก `v1.2.1` (ขึ้นต้นด้วย `v` ได้) แล้วอัปโหลด zip นั้นเป็น asset
5. ผู้ใช้ที่เปิดแอปเวอร์ชันที่มีระบบอัปเดต จะเห็นแบนเนอร์ “มีเวอร์ชันใหม่” แล้วกดอัปเดตได้

ถ้ายังไม่มี Release / ออฟไลน์ แอปจะเงียบหรือขึ้นว่าล่าสุดแล้ว — ไม่พัง
