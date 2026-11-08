/**
 * WhatsApp Helper Utilities & Templates for Superadmin
 */

export function cleanPhoneNumber(phone) {
  if (!phone) return ''
  let cleaned = phone.replace(/[^0-9]/g, '')
  if (cleaned.startsWith('03')) {
    cleaned = '92' + cleaned.substring(1)
  } else if (cleaned.length === 10 && !cleaned.startsWith('92')) {
    cleaned = '92' + cleaned
  }
  return cleaned
}

export function buildWhatsAppUrl(phone, message) {
  const cleaned = cleanPhoneNumber(phone)
  const encoded = encodeURIComponent(message)
  return cleaned ? `https://wa.me/${cleaned}?text=${encoded}` : `https://wa.me/?text=${encoded}`
}

export function formatOnboardingMessage({ shopName, username, password, planName, loginUrl = 'https://pos.edgexsuite.com' }) {
  return `🎉 *Welcome to EdgeX POS!*

Assalam-o-Alaikum,
Aapka POS store *${shopName}* kamyabi se active kar diya gaya hai!

🌐 *Login Portal:* ${loginUrl}
👤 *Username:* ${username}
🔑 *Password:* ${password}
📦 *Plan:* ${planName || 'Standard Plan'}

📌 *Hidayat:*
• Apne computer ya mobile browser mein Login Portal open karein.
• Uper diye gaye Username aur Password se login karein.
• First time products aur categories add karke sale shuru karein!

Kisi bhi sawal ya madad ke liye EdgeX Support se rabta karein.
Shukriya! 🚀`
}

export function formatUserCredentialsMessage({ shopName, username, password, role = 'Cashier', loginUrl = 'https://pos.edgexsuite.com' }) {
  return `🔑 *EdgeX POS - Staff Credentials*

Store: *${shopName}*
Aapka staff account create/update kar diya gaya hai:

🌐 *Login Portal:* ${loginUrl}
👤 *Username:* ${username}
🔑 *Password:* ${password}
💼 *Role:* ${role.toUpperCase()}

Kisi bhi madad ke liye apne store admin se rabta karein.`
}

export function formatRenewalMessage({ shopName, planName, expiryDate, amount, bankDetails, isOverdue = false }) {
  const formattedDate = expiryDate ? new Date(expiryDate).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Soon'
  
  if (isOverdue) {
    return `⚠️ *URGENT: POS Subscription Overdue - ${shopName}*

Dear Customer,
Aapke store *${shopName}* ka EdgeX POS subscription (*${planName || 'Plan'}*) expire ho chuka hai.

📅 *Expiry Date:* ${formattedDate}
💰 *Payable Amount:* Rs. ${Number(amount || 0).toLocaleString()}

Bila-taatool service jari rakhne ke liye baraye meherbani foran payment clear karein taakay aapka store suspend na ho.

🏦 *Payment Account Details:*
${bankDetails || 'Bank: Meezan Bank / HBL\nJazzCash / EasyPaisa: 0300-XXXXXXX\nAccount Title: EdgeX POS'}

Payment ke baad screenshot isi WhatsApp par share karein.
Shukriya!
*EdgeX POS Administration*`
  }

  return `🔔 *Subscription Renewal Reminder - ${shopName}*

Assalam-o-Alaikum,
Aapke store *${shopName}* ka EdgeX POS subscription (*${planName || 'Plan'}*) jald expire hone wala hai.

📅 *Due Date:* ${formattedDate}
💰 *Subscription Fee:* Rs. ${Number(amount || 0).toLocaleString()}

Aapki billing aur POS services uninterrupted chalne ke liye baraye meherbani waqt par renewal ada farmayein.

🏦 *Payment Details:*
${bankDetails || 'Bank: Meezan Bank / HBL\nJazzCash / EasyPaisa: 0300-XXXXXXX\nAccount Title: EdgeX POS'}

Payment ke baad slip isi WhatsApp par share karein.
Shukriya!
*EdgeX POS Support Team*`
}
