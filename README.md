# TikTok View Alert

เว็บแอปติดตามยอดวิววิดีโอ TikTok สาธารณะ ส่งอีเมลแจ้งเตือนเมื่อถึงเป้าหมาย โดยบันทึกข้อมูลไว้ในเครื่องที่รันแอป

## เริ่มใช้งาน

ต้องมี Node.js 20 ขึ้นไป

```powershell
npm install
npm start
```

เปิด `http://localhost:3000` เพิ่มลิงก์วิดีโอและยอดวิวเป้าหมาย จากนั้นตั้งค่า Google OAuth2 เพื่อส่งแจ้งเตือนผ่าน Gmail API ไปที่ `apisityambangyang@gmail.com`

## ตั้งค่า Google OAuth2

1. ใน [Google Cloud Console](https://console.cloud.google.com/) สร้างโปรเจกต์ แล้วเปิด **Gmail API** ใน APIs & Services → Library
2. ที่ Google Auth Platform → Data Access เพิ่ม scope `https://www.googleapis.com/auth/gmail.send` และเพิ่ม `apisityambangyang@gmail.com` เป็น test user ในหน้า Audience ขณะสถานะยังเป็น Testing
3. ไปที่ APIs & Services → Credentials → Create Credentials → OAuth client ID → **Web application**
4. เพิ่ม Authorized redirect URI ให้ตรงทุกตัวอักษร: `http://localhost:3000/auth/google/callback`
5. คัดลอก Client ID และ Client Secret ลงหน้า **ตั้งค่าอีเมล** แล้วกดบันทึก จากนั้นกด **เชื่อมต่อ Google** และอนุญาตบัญชี `apisityambangyang@gmail.com`
6. กลับมาหน้าแอปแล้วกด **ส่งอีเมลทดสอบ**

หาก Gmail API ตอบ `403 insufficient authentication scopes` ให้ตรวจ scope ข้างต้นในโปรเจกต์เดียวกับ OAuth Client ID แล้วกด **รีเซ็ตสิทธิ์ Google** ในหน้าตั้งค่า จากนั้นกด **เชื่อมต่อ Google** และอนุญาต `gmail.send` ใหม่

แอปขอ scope `gmail.send` เพื่อส่งอีเมล และ `openid email` เพื่อยืนยันตัวตนเท่านั้น ไม่ได้ขอสิทธิ์อ่านกล่องจดหมาย ข้อมูล Client Secret และ refresh token เก็บไว้ใน `data/store.json` เฉพาะเครื่องนี้

หมายเหตุ: OAuth consent screen ที่ยังอยู่ในสถานะ Testing จะทำให้ refresh token สำหรับ Gmail API หมดอายุหลัง 7 วันตามข้อกำหนด Google หากต้องการให้ระบบติดตามต่อเนื่อง ต้องตั้งค่าแอป/การเผยแพร่ OAuth ให้เหมาะสมตามข้อกำหนดของ Google

ระบบตรวจสอบทุก 30 วินาที ปรับได้ด้วย environment variable `POLL_INTERVAL_SECONDS` (หน่วยเป็นวินาที, ขั้นต่ำ 30 วินาที) แอปจะต้องเปิดและเชื่อมต่ออินเทอร์เน็ตอยู่เพื่อทำงาน

## ข้อจำกัด

- ระบบอ่านยอดวิวจากข้อมูลหน้าเว็บสาธารณะของ TikTok ซึ่ง TikTok อาจเปลี่ยนรูปแบบ จำกัดคำขอ หรือไม่แสดงยอดสำหรับวิดีโอบางรายการ/ลิงก์สั้น หากอ่านไม่ได้ รายการจะแสดงข้อผิดพลาดและลองใหม่รอบถัดไป
- ไม่สามารถติดตามวิดีโอส่วนตัวหรือรับประกันความหน่วงของการแจ้งเตือน ยอดเป้าหมายที่ใส่ต่ำกว่ายอดปัจจุบันจะส่งแจ้งเตือนในรอบตรวจสอบถัดไป
- Google OAuth Client Secret และ refresh token เก็บไว้ใน `data/store.json` ในเครื่อง ไฟล์นี้ไม่ถูกติดตามโดย Git แอปผูกพอร์ตกับ `127.0.0.1` และไม่มีระบบบัญชีผู้ใช้ จึงควรใช้เฉพาะบนเครื่องส่วนตัว
- หากต้องการรับแจ้งเตือนต่อเนื่องเมื่อปิดเครื่อง ต้องติดตั้งแอปบนเซิร์ฟเวอร์ที่เปิดตลอดเวลา

## ตรวจสอบ

```powershell
npm test
```