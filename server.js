require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccountKey.json"))
});

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(cors());
app.options("/create-checkout-session", cors());
app.options("/webhook", cors());




// 🔥 WEBHOOK (TEK VE DOĞRU)
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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

// Ödeme oluşturma
app.post("/create-checkout-session", async (req, res) => {
  try {
    const price = Number(req.body.price);

    if (isNaN(price) || price <= 0) {
      return res.status(400).json({
        error: "Invalid price"
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      metadata: {
        bookingId: req.body.bookingId || ""
      },

      line_items: [{
        price_data: {
          currency: "php",
product_data: {
  name: "Sivelio Spa Massage Service",
  description: "Massage and wellness appointment booking"
},
          unit_amount: price * 100,
        },
        quantity: 1,
      }],

      success_url: "https://sivelio.com/?success=true",
cancel_url: "https://sivelio.com/?canceled=true",
    });

    return res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});