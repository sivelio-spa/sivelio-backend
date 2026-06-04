require("dotenv").config();


console.log("STARTING SERVER...");
console.log("STRIPE:", process.env.STRIPE_SECRET_KEY ? "OK" : "MISSING");
console.log("FIREBASE KEY:", process.env.FIREBASE_PRIVATE_KEY ? "OK" : "MISSING");

const express = require("express");

const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, '\n')
  })
});

const app = express();

  
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));









// 🔥 WEBHOOK (TEK VE DOĞRU)
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  console.log("Webhook received");
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log("Webhook hata:", err.message);
    return res.status(400).send("Webhook Error");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata.bookingId;

    if (bookingId) {
      const ref = admin.firestore().collection("bookings").doc(bookingId);
await ref.set({ status: "paid" }, { merge: true });
      console.log("Ödeme OK:", bookingId);
    }
  }

  res.json({ received: true });
});

// 🔥 JSON middleware (webhook’tan SONRA)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// TEST
app.get("/", (req, res) => {
  res.send("Stripe backend is running");
});
app.post("/career-apply", async (req, res) => {
  console.log("🔥 CAREER ENDPOINT HIT");
  console.log("BODY:", req.body);

  try {
    const data = req.body;

    await resend.emails.send({
      from: "Sivelio <onboarding@resend.dev>",
      to: "sivelio75@gmail.com",
      subject: "New Career Application",
      html: `
        <h3>New Application</h3>
        <p><b>Name:</b> ${data.firstName} ${data.lastName}</p>
        <p><b>Phone:</b> ${data.phone}</p>
        <p><b>Email:</b> ${data.email}</p>
        <p><b>Position:</b> ${data.position}</p>
        <p><b>Message:</b> ${data.message}</p>
      `
    });

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/create-checkout-session", async (req, res) => {
  console.log("BODY:", req.body);
  if (!price || !bookingId) {
  return res.status(400).json({ error: "Missing price or bookingId" });
}
  try {
    const { price, bookingId } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Sivelio Booking",
            },
            unit_amount: price,
          },
          quantity: 1,
        },
      ],
      success_url: "https://sivelio.com/?success=true",
      cancel_url: "https://sivelio.com/?canceled=true",
      metadata: { bookingId },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});