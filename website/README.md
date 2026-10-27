# Twitch Chat TTS

อ่านแชท Twitch แบบ realtime แล้วแปลงเป็นเสียงพูดผ่าน **TokenMe API**  
ภาษาไทยเป็นหลัก · อังกฤษเป็นรอง · มีคิวข้อความ  
UI: Glass Soft (มืด · การ์ดโปร่ง · ม่วง Twitch)

## วิธีใช้ (เว็บ)

1. ใส่ **TokenMe API Key** ในช่อง API Key (เก็บใน `localStorage` บนเครื่องคุณเท่านั้น — ไม่ถูก hardcode ในโค้ด)
2. รัน proxy กัน CORS:
   ```bash
   python3 proxy/tokenme_proxy.py
   # ฟังที่ http://127.0.0.1:8765
   ```
3. เปิด `index.html` ด้วย Chrome (หรือ `python3 -m http.server 8080`)
4. ใส่ชื่อช่อง Twitch → เชื่อมต่อ → ทดสอบเสียง

### API Key มาจากไหน
สมัคร/สร้างคีย์ที่บริการ TokenMe แล้ววางในช่อง **API Key**  
หรือตั้งใน environment ของ proxy ก็ได้เฉพาะตอน forward จาก request header (แอปส่ง `Authorization: Bearer …` เอง)

ค่าเริ่มต้น:
- model: `paxa/paxa-tts-flash-v2`
- voice: `mocha`
- endpoint: `POST https://api.tokenme.limited/api/v1/audio/speech`

## ผู้ให้บริการ TTS
- **TokenMe** (ค่าเริ่มต้น) — ต้องมีเน็ต + API key + proxy (ถ้าเปิดจากไฟล์/โดเมนที่โดน CORS)
- **Web Speech** — สำรองในเบราว์เซอร์ ไม่ต้องคีย์ แต่คุณภาพไทยขึ้นกับเครื่อง

## Portable Windows (.exe)
แตก zip → เปิด `TwitchChatTTS.exe` → ใส่ API Key → ใส่ช่อง → เชื่อมต่อ  
แอปเปิด proxy ในเครื่องให้อัตโนมัติ ไม่ต้องรัน Python

Windows Defender / SmartScreen อาจเตือนเพราะไฟล์ยังไม่เซ็นชื่อ → More info → Run anyway

## โครงสร้าง
```
twitch-tts/
  index.html
  app.js
  styles.css
  README.md
  proxy/tokenme_proxy.py
```

สร้างสำหรับ Watchara · ใช้งานส่วนตัวบนช่องที่คุณกำหนด
