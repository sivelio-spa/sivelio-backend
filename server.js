require("dotenv").config();
console.log("🔥 SERVER ACTIVE - NEW DEPLOY LOADED");

console.log("STARTING SERVER...");
console.log("STRIPE:", process.env.STRIPE_SECRET_KEY ? "OK" : "MISSING");
console.log("FIREBASE KEY:", process.env.FIREBASE_PRIVATE_KEY ? "OK" : "MISSING");

const express = require("express");

const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const crypto = require("crypto");
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
const SERVICE_PRICES = {
  Relaxation: 140000,
  "Deep Tissue": 160000,
  Aromatherapy: 150000
};
async function getActivePoolCapacity(poolId) {

  const snapshot =
    await admin.firestore()
      .collection("masseuses")
      .where("poolId", "==", poolId)
      .get();

  let capacity = 0;

  snapshot.forEach(docSnap => {

    const masseuse = docSnap.data();

    if (
      masseuse.employmentStatus === "active"
    ) {
      capacity++;
    }
  });

  return capacity;
}
function bookingBlocksCapacity(booking, now) {

  if (
    booking.status === "cancelled" ||
    booking.status === "archived" ||
    booking.status === "completed"
  ) {
    return false;
  }

  if (
    booking.status === "pending" &&
    booking.paymentStatus !== "paid" &&
    Number(booking.expiresAt || 0) <= now
  ) {
    return false;
  }

  return true;
}
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

  const db = admin.firestore();
  const ref = db.collection("bookings").doc(bookingId);

  const bookingSnap = await ref.get();

  if (!bookingSnap.exists) {
    console.log("Booking bulunamadı:", bookingId);
  } else {

    const booking = bookingSnap.data();

    await ref.set(
      { paymentStatus: "paid" },
      { merge: true }
    );

    console.log("Ödeme OK:", bookingId);

    if (booking.poolId) {

      const masseusesSnap = await db
  .collection("masseuses")
  .where("poolId", "==", booking.poolId)
  .where("availability", "==", "online")
  .where("employmentStatus", "==", "active")
  .get();

      const tokens = [
        ...new Set(
          masseusesSnap.docs
            .map(doc => doc.data().fcmToken)
            .filter(Boolean)
        )
      ];

      if (tokens.length > 0) {

        const response = await admin.messaging().sendEachForMulticast({
          tokens: tokens,

          notification: {
            title: "Yeni Sivelio Randevusu",
            body: `${booking.poolId} için yeni ücretli randevu. Paneli açın.`
          },

          data: {
            bookingId: bookingId,
            poolId: String(booking.poolId)
          }
        });

        console.log(
          "Bildirim gönderildi:",
          response.successCount,
          "başarılı,",
          response.failureCount,
          "başarısız"
        );
      } else {
        console.log("Bu havuzda bildirim tokenı bulunamadı:", booking.poolId);
      }
    }
  }
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
app.get("/pool-capacity", async (req, res) => {
  try {
    const poolId = String(req.query.poolId || "").trim();

    if (!/^Masseuse([1-9]|[1-9][0-9]|100)$/.test(poolId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid poolId"
      });
    }

    const snapshot = await admin.firestore()
      .collection("masseuses")
      .where("poolId", "==", poolId)
      .get();

    let capacity = 0;

    snapshot.forEach(docSnap => {
      const masseuse = docSnap.data();

      if (masseuse.employmentStatus === "active") {
        capacity++;
      }
    });

    res.json({
      ok: true,
      poolId,
      capacity
    });

  } catch (error) {
    console.error("POOL CAPACITY ERROR:", error);

    res.status(500).json({
      ok: false,
      error: "Could not get pool capacity"
    });
  }
});
app.post("/create-booking", async (req, res) => {

  const db = admin.firestore();

  try {

    const name =
      String(req.body.name || "").trim();

    const address =
      String(req.body.address || "").trim();

    const service =
      String(req.body.service || "").trim();

    const date =
      String(req.body.date || "").trim();

    const time =
      String(req.body.time || "").trim();

    const poolId =
      String(req.body.poolId || "").trim();


    if (
      !name ||
      !address ||
      !service ||
      !date ||
      !time ||
      !poolId
    ) {
      return res.status(400).json({
        ok: false,
        error: "Required fields are missing."
      });
    }


    if (!SERVICE_PRICES[service]) {
      return res.status(400).json({
        ok: false,
        error: "Invalid service."
      });
    }


    if (
      !/^Masseuse([1-9]|[1-9][0-9]|100)$/.test(poolId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid poolId."
      });
    }


    const bookingRef =
      db.collection("bookings").doc();

    const chatKey =
      crypto.randomUUID();
const slotLockId =
  `${poolId}_${date}_${time}`
    .replace(/[^A-Za-z0-9_-]/g, "_");

const slotLockRef =
  db.collection("bookingSlotLocks")
    .doc(slotLockId);

    await db.runTransaction(
      async transaction => {
await transaction.get(
  slotLockRef
);
        const masseuseQuery =
          db.collection("masseuses")
            .where(
              "poolId",
              "==",
              poolId
            );

        const bookingQuery =
          db.collection("bookings")
            .where(
              "date",
              "==",
              date
            );


        const masseuseSnapshot =
          await transaction.get(
            masseuseQuery
          );

        const bookingSnapshot =
          await transaction.get(
            bookingQuery
          );


        let capacity = 0;

        masseuseSnapshot.forEach(
          docSnap => {

            const masseuse =
              docSnap.data();

            if (
              masseuse.employmentStatus ===
              "active"
            ) {
              capacity++;
            }
          }
        );


        if (capacity <= 0) {
          throw new Error(
            "NO_CAPACITY"
          );
        }


        const now =
          Date.now();

        let usedCapacity = 0;


        bookingSnapshot.forEach(
          docSnap => {

            const booking =
              docSnap.data();

            const bookingPool =
              booking.poolId ||
              booking.masseuse;


            if (
              bookingPool !== poolId ||
              booking.time !== time
            ) {
              return;
            }


            if (
              bookingBlocksCapacity(
                booking,
                now
              )
            ) {
              usedCapacity++;
            }
          }
        );


        if (
          usedCapacity >= capacity
        ) {
          throw new Error(
            "TIME_FULL"
          );
        }
transaction.set(
  slotLockRef,
  {
    updatedAt:
      admin.firestore.FieldValue.serverTimestamp()
  },
  {
    merge: true
  }
);

        transaction.set(
          bookingRef,
          {
            name,
            address,
            service,
            date,
            time,

            masseuse: poolId,
            poolId,

            assignedMasseuseUid: null,
            assignedMasseuseName: null,

            chatKey,

            price:
              SERVICE_PRICES[service],

            status: "pending",
            paymentStatus: "pending",

            createdAt: now,
            expiresAt:
              now + 15 * 60 * 1000
          }
        );
      }
    );


    return res.json({
      ok: true,
      bookingId: bookingRef.id,
      price: SERVICE_PRICES[service]
    });


  } catch (error) {

    if (
      error.message === "TIME_FULL"
    ) {
      return res.status(409).json({
        ok: false,
        error: "TIME_FULL"
      });
    }


    if (
      error.message === "NO_CAPACITY"
    ) {
      return res.status(409).json({
        ok: false,
        error: "NO_CAPACITY"
      });
    }


    console.error(
      "CREATE BOOKING ERROR:",
      error
    );


    return res.status(500).json({
      ok: false,
      error:
        "Booking could not be created."
    });
  }
});
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { bookingId } = req.body;

    console.log("BODY:", req.body);
if (!bookingId) {
  return res.status(400).json({
    error: "bookingId is required"
  });
}

const bookingRef =
  admin.firestore()
    .collection("bookings")
    .doc(String(bookingId));

const bookingSnap =
  await bookingRef.get();

if (!bookingSnap.exists) {
  return res.status(404).json({
    error: "Booking not found"
  });
}

const booking =
  bookingSnap.data();

if (
  booking.status !== "pending" ||
  booking.paymentStatus !== "pending"
) {
  return res.status(409).json({
    error: "Booking is not payable"
  });
}

if (
  Number(booking.expiresAt || 0) <=
  Date.now()
) {
  return res.status(409).json({
    error: "Booking expired"
  });
}

const expectedPrice =
  SERVICE_PRICES[booking.service];

if (
  !expectedPrice ||
  Number(booking.price) !== expectedPrice
) {
  return res.status(400).json({
    error: "Invalid booking price"
  });
}
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "php",
            product_data: {
              name: "Sivelio Booking",
            },
            unit_amount: expectedPrice,
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
// MASSEUSE TEST
app.get("/test-masseuses", async (req, res) => {
  try {
    const snapshot = await admin.firestore()
      .collection("masseuses")
      .limit(1)
      .get();

    res.json({
      ok: true,
      masseusesCollectionExists: !snapshot.empty
    });

  } catch (error) {
    console.error("MASSEUSE TEST ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
async function findBestPool(db) {
  const snap = await db.collection("masseuses").get();

  const counts = Array(100).fill(0);

  snap.forEach(docSnap => {
    const poolId = String(docSnap.data().poolId || "");
    const match = poolId.match(/^Masseuse(\d+)$/);

    if (!match) return;

    const number = Number(match[1]);

    if (number >= 1 && number <= 100) {
      counts[number - 1]++;
    }
  });

  let bestIndex = 0;

  for (let i = 1; i < counts.length; i++) {
    if (counts[i] < counts[bestIndex]) {
      bestIndex = i;
    }
  }

  return `Masseuse${bestIndex + 1}`;
}


app.post("/career-apply", async (req, res) => {

  console.log("🔥 CAREER ENDPOINT HIT");

  const db = admin.firestore();

  let createdUid = null;
  let applicationRef = null;

  try {

    const firstName = String(req.body.firstName || "").trim();
    const lastName = String(req.body.lastName || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const position = String(req.body.position || "").trim();
    const message = String(req.body.message || "").trim();

    if (!firstName || !lastName || !email || !position) {
      return res.status(400).json({
        ok: false,
        error: "Required fields are missing."
      });
    }

    const emailIsValid =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!emailIsValid) {
      return res.status(400).json({
        ok: false,
        error: "Invalid email address."
      });
    }


    // DRIVER / COURIER:
    // Normal application only.
    if (position !== "Therapist") {

      applicationRef = await db
        .collection("careerApplications")
        .add({
          firstName,
          lastName,
          phone,
          email,
          position,
          message,
          status: "received",
          createdAt:
            admin.firestore.FieldValue.serverTimestamp()
        });

      const adminMail = await resend.emails.send({
        from:
          process.env.CAREER_FROM_EMAIL ||
          "Sivelio <onboarding@resend.dev>",

        to: "sivelio75@gmail.com",

        subject: `New Career Application - ${position}`,

        html: `
          <h3>New Application</h3>

          <p><b>Name:</b> ${firstName} ${lastName}</p>
          <p><b>Phone:</b> ${phone}</p>
          <p><b>Email:</b> ${email}</p>
          <p><b>Position:</b> ${position}</p>
          <p><b>Message:</b> ${message}</p>
        `
      });

      if (adminMail.error) {
        console.log(
          "ADMIN EMAIL ERROR:",
          adminMail.error
        );
      }

      return res.json({
        ok: true,
        hired: false
      });
    }


    // THERAPIST:
    // Existing Firebase account must not be converted automatically.
    try {

      await admin.auth().getUserByEmail(email);

      return res.status(409).json({
        ok: false,
        error:
          "This email address is already registered."
      });

    } catch (error) {

      if (error.code !== "auth/user-not-found") {
        throw error;
      }
    }


    // Random temporary password.
    // Applicant never needs to know this password.
    const temporaryPassword =
      crypto.randomBytes(24).toString("hex") +
      "Aa1!";


    // Create Firebase Authentication account.
    const userRecord =
      await admin.auth().createUser({
        email,
        password: temporaryPassword,
        displayName: `${firstName} ${lastName}`,
        disabled: false
      });

    createdUid = userRecord.uid;


    // Automatically choose the least populated pool.
    const poolId = await findBestPool(db);


    // Create masseuse record.
    await db
      .collection("masseuses")
      .doc(createdUid)
      .set({
        uid: createdUid,

        name: `${firstName} ${lastName}`,

        firstName,
        lastName,

        email,
        phone,

        poolId,

        availability: "offline",

        employmentStatus: "active",

        role: "masseuse",

        source: "career",

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      });


    // Save the career application.
    applicationRef = await db
      .collection("careerApplications")
      .add({
        firstName,
        lastName,
        phone,
        email,
        position,
        message,

        status: "hired_pending_onboarding",

        masseuseUid: createdUid,
        poolId,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      });


    // Secure password setup link.
    const passwordSetupLink =
      await admin.auth().generatePasswordResetLink(
        email,
        {
          url: "https://sivelio.com/login.html"
        }
      );


    // Send the applicant their hiring/onboarding email.
    const applicantMail =
      await resend.emails.send({

        from:
          process.env.CAREER_FROM_EMAIL ||
          "Sivelio <onboarding@resend.dev>",

        to: email,

        subject:
          "Congratulations - You have been hired by Sivelio",

        html: `
          <h2>Welcome to Sivelio</h2>

          <p>
            Hello ${firstName},
          </p>

          <p>
            Congratulations! You have been hired
            as a Sivelio Therapist.
          </p>

          <p>
            Your therapist account has been created.
          </p>

          <p>
            Your account starts in
            <b>OFFLINE</b> mode.
            You will not receive customer bookings
            until you sign in and choose Online.
          </p>

          <p>
            Use the secure link below to create
            your password:
          </p>

          <p>
            <a href="${passwordSetupLink}">
              Create My Sivelio Password
            </a>
          </p>

          <p>
            After creating your password,
            sign in to the Sivelio therapist panel.
          </p>

          <p>
            Welcome to the Sivelio team.
          </p>
        `
      });


    if (applicantMail.error) {

      console.log(
        "APPLICANT EMAIL ERROR:",
        applicantMail.error
      );

      // Do not leave an unusable therapist account.
      await db
        .collection("masseuses")
        .doc(createdUid)
        .delete();

      await admin.auth().deleteUser(createdUid);

      await applicationRef.update({
        status: "onboarding_email_failed"
      });

      return res.status(500).json({
        ok: false,
        error:
          "The onboarding email could not be sent."
      });
    }


    await applicationRef.update({
      status: "hired"
    });


    // Inform admin too.
    const adminMail =
      await resend.emails.send({

        from:
          process.env.CAREER_FROM_EMAIL ||
          "Sivelio <onboarding@resend.dev>",

        to: "sivelio75@gmail.com",

        subject:
          "New Sivelio Therapist Automatically Hired",

        html: `
          <h3>New Therapist</h3>

          <p>
            <b>Name:</b>
            ${firstName} ${lastName}
          </p>

          <p>
            <b>Email:</b>
            ${email}
          </p>

          <p>
            <b>Phone:</b>
            ${phone}
          </p>

          <p>
            <b>Pool:</b>
            ${poolId}
          </p>

          <p>
            <b>Status:</b>
            Active / Offline
          </p>
        `
      });


    if (adminMail.error) {
      console.log(
        "ADMIN EMAIL ERROR:",
        adminMail.error
      );
    }


    console.log(
      "✅ THERAPIST AUTO HIRED:",
      email,
      poolId
    );


    return res.json({
      ok: true,
      hired: true,
      poolId
    });


  } catch (err) {

    console.log("CAREER ERROR:", err);

    // Cleanup if account creation stopped halfway.
    if (createdUid) {

      try {
        await db
          .collection("masseuses")
          .doc(createdUid)
          .delete();
      } catch (_) {}

      try {
        await admin.auth().deleteUser(createdUid);
      } catch (_) {}
    }

    if (applicationRef) {
      try {
        await applicationRef.update({
          status: "failed"
        });
      } catch (_) {}
    }

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});