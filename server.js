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
const WEEK_DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
];

function masseuseWorksAt(
  masseuse,
  date,
  time
) {

  const schedule =
    masseuse.weeklyAvailability;

  // Henüz takvim oluşturmamış eski hesaplar
  // mevcut sistemdeki gibi çalışmaya devam eder.
  if (
    !schedule ||
    typeof schedule !== "object"
  ) {
    return true;
  }

  const dayIndex =
    new Date(
      date + "T12:00:00Z"
    ).getUTCDay();

  const dayName =
    WEEK_DAYS[dayIndex];

  const day =
    schedule[dayName];

  if (
    !day ||
    day.enabled !== true
  ) {
    return false;
  }

  const start =
    String(day.start || "");

  const end =
    String(day.end || "");

  if (
    !/^\d{2}:\d{2}$/.test(start) ||
    !/^\d{2}:\d{2}$/.test(end)
  ) {
    return false;
  }

  return (
    time >= start &&
    time < end
  );
}
async function requireFirebaseAuth(req, res, next) {

  try {

    const authHeader =
      String(req.headers.authorization || "");

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        error: "Authentication required."
      });
    }

    const idToken =
      authHeader.substring(7);

    const decodedToken =
      await admin.auth().verifyIdToken(idToken);

    req.user = decodedToken;

    next();

  } catch (error) {

    console.error(
      "AUTH ERROR:",
      error.message
    );

    return res.status(401).json({
      ok: false,
      error: "Invalid authentication."
    });
  }
}
const allowedOrigins = [
  "https://sivelio.com",
  "https://www.sivelio.com",
  "https://sivelio.web.app",
  "https://sivelio.firebaseapp.com",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost",
  "https://localhost",
  "capacitor://localhost"
];

app.use(cors({
  origin: function (origin, callback) {

    // Stripe webhook / server-to-server istekleri gibi
    // Origin göndermeyen istekleri engelleme.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error("Origin not allowed by CORS")
    );
  },

  methods: ["GET", "POST", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ]
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
    const customerEmail =
  String(
    session.customer_details?.email || ""
  ).trim().toLowerCase();

if (
  customerEmail &&
  booking.confirmationEmailSent !== true
) {
  try {
  

  const amountPaid =
    ((Number(booking.price) || 0) / 100)
      .toFixed(2);

  const confirmationMail =
    await resend.emails.send({

      from:
        process.env.BOOKING_FROM_EMAIL ||
        process.env.CAREER_FROM_EMAIL ||
        "Sivelio <onboarding@resend.dev>",

      to: customerEmail,

      subject:
        "Sivelio Spa - Booking Confirmed",

      text: [
        `Hello ${String(booking.name || "Customer")},`,
        "",
        "Your Sivelio Spa booking and payment have been confirmed.",
        "",
        `Booking ID: ${bookingId}`,
        `Service: ${String(booking.service || "-")}`,
        `Date: ${String(booking.date || "-")}`,
        `Time: ${String(booking.time || "-")}`,
        `Amount Paid: PHP ${amountPaid}`,
        "Payment Status: Confirmed",
        "",
        "Your masseuse will be assigned through the Sivelio system.",
        "",
        "Thank you for choosing Sivelio Spa."
      ].join("\n")
    });

  if (confirmationMail.error) {

    console.error(
      "BOOKING CONFIRMATION EMAIL ERROR:",
      confirmationMail.error
    );

  } else {

    await ref.set(
      {
        confirmationEmailSent: true,
        confirmationEmailSentAt:
          admin.firestore.FieldValue
            .serverTimestamp()
      },
      {
        merge: true
      }
    );
  }
} catch (emailError) {
  console.error(
    "BOOKING CONFIRMATION EMAIL ERROR:",
    emailError.message
  );
}
}
    if (
  booking.poolId &&
  booking.status === "pending" &&
  !booking.assignedMasseuseUid
) {
const eligibleMasseusesSnap =
  await db
    .collection("masseuses")
    .where("poolId", "==", booking.poolId)
    .where("employmentStatus", "==", "active")
    .get();

const eligibleUids =
  eligibleMasseusesSnap.docs
    .filter(docSnap =>
      masseuseWorksAt(
        docSnap.data(),
        String(booking.date || ""),
        String(booking.time || "")
      )
    )
    .map(docSnap =>
      String(docSnap.data().uid || "").trim()
    )
    .filter(Boolean);
  await db
    .collection("bookingDispatches")
    .doc(bookingId)
    .set(
      {
        bookingId: bookingId,

        poolId:
          String(booking.poolId),
eligibleUids,
        date:
          String(booking.date || ""),

        time:
          String(booking.time || ""),

        service:
          String(booking.service || ""),

        price:
          Number(booking.price) || 0,

        status: "available",
        paymentStatus: "paid",

        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      },
      {
        merge: true
      }
    );
}

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
      .filter(docSnap =>
        masseuseWorksAt(
          docSnap.data(),
          String(booking.date || ""),
          String(booking.time || "")
        )
      )
      .map(docSnap =>
        docSnap.data().fcmToken
      )
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
app.get("/available-pools", async (req, res) => {

  try {

    const snapshot =
      await admin.firestore()
        .collection("masseuses")
        .where(
          "employmentStatus",
          "==",
          "active"
        )
        .get();

    const poolCounts = {};

    snapshot.forEach(docSnap => {

      const poolId =
        String(
          docSnap.data().poolId || ""
        );

      if (
        !/^Masseuse([1-9]|[1-9][0-9]|100)$/
          .test(poolId)
      ) {
        return;
      }

      poolCounts[poolId] =
        (poolCounts[poolId] || 0) + 1;
    });

    const pools =
      Object.keys(poolCounts)
        .sort((a, b) => {

          return (
            Number(a.replace("Masseuse", "")) -
            Number(b.replace("Masseuse", ""))
          );
        });

    return res.json({
      ok: true,
      pools,
      poolCounts
    });

  } catch (error) {

    console.error(
      "AVAILABLE POOLS ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Available pools could not be loaded."
    });
  }
});
app.get(
  "/masseuse-schedule",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const db =
        admin.firestore();

      const snapshot =
        await db
          .collection("masseuses")
          .where(
            "uid",
            "==",
            req.user.uid
          )
          .limit(1)
          .get();

      if (snapshot.empty) {
        return res.status(403).json({
          ok: false,
          error:
            "Masseuse account not found."
        });
      }

      const masseuse =
        snapshot.docs[0].data();

      return res.json({
        ok: true,
        weeklyAvailability:
          masseuse.weeklyAvailability ||
          null
      });

    } catch (error) {

      console.error(
        "GET SCHEDULE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Schedule could not be loaded."
      });
    }
  }
);


app.post(
  "/masseuse-schedule",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const db =
        admin.firestore();

      const snapshot =
        await db
          .collection("masseuses")
          .where(
            "uid",
            "==",
            req.user.uid
          )
          .limit(1)
          .get();

      if (snapshot.empty) {
        return res.status(403).json({
          ok: false,
          error:
            "Masseuse account not found."
        });
      }

      const masseuseRef =
        snapshot.docs[0].ref;

      const masseuse =
        snapshot.docs[0].data();

      if (
        masseuse.employmentStatus !==
        "active"
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "ACCOUNT_NOT_ACTIVE"
        });
      }

      const incoming =
        req.body.weeklyAvailability;

      if (
        !incoming ||
        typeof incoming !== "object"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid schedule."
        });
      }

      const normalized = {};

      for (
        const dayName of WEEK_DAYS
      ) {

        const day =
          incoming[dayName] || {};

        const enabled =
          day.enabled === true;

        const start =
          String(
            day.start || "09:00"
          );

        const end =
          String(
            day.end || "18:00"
          );

        if (
          enabled &&
          (
            !/^\d{2}:\d{2}$/.test(start) ||
            !/^\d{2}:\d{2}$/.test(end) ||
            start >= end
          )
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Invalid working hours."
          });
        }

        normalized[dayName] = {
          enabled,
          start,
          end
        };
      }

      await masseuseRef.update({
        weeklyAvailability:
          normalized
      });

      return res.json({
        ok: true
      });

    } catch (error) {

      console.error(
        "SAVE SCHEDULE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Schedule could not be saved."
      });
    }
  }
);
app.get("/slot-availability", async (req, res) => {

  try {

    const poolId =
      String(req.query.poolId || "").trim();

    const date =
      String(req.query.date || "").trim();


    if (
      !/^Masseuse([1-9]|[1-9][0-9]|100)$/.test(poolId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid poolId."
      });
    }


    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid date."
      });
    }


    const db =
      admin.firestore();

  const masseuseSnapshot =
  await db
    .collection("masseuses")
    .where(
      "poolId",
      "==",
      poolId
    )
    .get();

    const bookingSnapshot =
      await db
        .collection("bookings")
        .where("date", "==", date)
        .get();


    const bookingCounts = {};

    const now = Date.now();


    bookingSnapshot.forEach(docSnap => {

      const booking =
        docSnap.data();

      const bookingPool =
        booking.poolId ||
        booking.masseuse;


      if (bookingPool !== poolId) {
        return;
      }


      if (
        !bookingBlocksCapacity(
          booking,
          now
        )
      ) {
        return;
      }


      if (!booking.time) {
        return;
      }


      bookingCounts[booking.time] =
        (bookingCounts[booking.time] || 0) + 1;
    });


    const unavailableTimes = [];

    for (let i = 0; i < 24; i++) {

      const hour =
        String(i).padStart(2, "0") + ":00";
let capacity = 0;

masseuseSnapshot.forEach(
  docSnap => {

    const masseuse =
      docSnap.data();

    if (
      masseuse.employmentStatus ===
        "active" &&
      masseuseWorksAt(
        masseuse,
        date,
        hour
      )
    ) {
      capacity++;
    }
  }
);
      const used =
        bookingCounts[hour] || 0;

      if (
        capacity === 0 ||
        used >= capacity
      ) {
        unavailableTimes.push(hour);
      }
    }


    return res.json({
      ok: true,
      unavailableTimes
    });

  } catch (error) {

    console.error(
      "SLOT AVAILABILITY ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Availability could not be loaded."
    });
  }
});
app.post("/create-booking", requireFirebaseAuth, async (req, res) => {

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
  bookingRef.id;
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
    "active" &&
  masseuseWorksAt(
    masseuse,
    date,
    time
  )
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
            customerUid: req.user.uid,
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
app.post("/create-checkout-session", requireFirebaseAuth, async (req, res) => {
  try {
    const { bookingId } = req.body;

    
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
  booking.customerUid !==
  req.user.uid
) {
  return res.status(403).json({
    error: "This booking does not belong to you."
  });
}

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
app.post(
  "/accept-booking",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const bookingId =
        String(
          req.body.bookingId || ""
        ).trim();


      if (!bookingId) {
        return res.status(400).json({
          ok: false,
          error: "bookingId is required."
        });
      }


      const db =
        admin.firestore();


      const masseuseSnapshot =
        await db
          .collection("masseuses")
          .where(
            "uid",
            "==",
            req.user.uid
          )
          .limit(1)
          .get();


      if (masseuseSnapshot.empty) {
        return res.status(403).json({
          ok: false,
          error: "Masseuse account not found."
        });
      }


      const masseuseRef =
        masseuseSnapshot.docs[0].ref;

      const bookingRef =
        db.collection("bookings")
          .doc(bookingId);

      const dispatchRef =
        db.collection("bookingDispatches")
          .doc(bookingId);


      await db.runTransaction(
        async transaction => {

          const bookingSnap =
            await transaction.get(
              bookingRef
            );

          const masseuseSnap =
            await transaction.get(
              masseuseRef
            );


          if (!bookingSnap.exists) {
            throw new Error(
              "BOOKING_NOT_FOUND"
            );
          }


          if (!masseuseSnap.exists) {
            throw new Error(
              "MASSEUSE_NOT_FOUND"
            );
          }


          const booking =
            bookingSnap.data();

          const masseuse =
            masseuseSnap.data();


          if (
            masseuse.uid !==
            req.user.uid
          ) {
            throw new Error(
              "NOT_AUTHORIZED"
            );
          }


          if (
            masseuse.employmentStatus !==
            "active"
          ) {
            throw new Error(
              "ACCOUNT_NOT_ACTIVE"
            );
          }


          if (
            masseuse.availability !==
            "online"
          ) {
            throw new Error(
              "MASSEUSE_OFFLINE"
            );
          }


          if (
            booking.status !== "pending" ||
            booking.paymentStatus !== "paid" ||
            booking.assignedMasseuseUid
          ) {
            throw new Error(
              "BOOKING_NOT_AVAILABLE"
            );
          }


          if (
            booking.poolId !==
            masseuse.poolId
          ) {
            throw new Error(
              "WRONG_POOL"
            );
          }
          if (
  !masseuseWorksAt(
    masseuse,
    String(booking.date || ""),
    String(booking.time || "")
  )
) {
  throw new Error(
    "OUTSIDE_WORKING_HOURS"
  );
}


          transaction.update(
            bookingRef,
            {
              assignedMasseuseUid:
                masseuse.uid,

              assignedMasseuseName:
                masseuse.name,

              status: "assigned",

              chatKey:
  bookingId,

              assignedAt:
                admin.firestore.FieldValue
                  .serverTimestamp()
            }
          );


          transaction.update(
            masseuseRef,
            {
              availability:
                "offline"
            }
          );


          transaction.delete(
            dispatchRef
          );
        }
      );


      return res.json({
        ok: true
      });


    } catch (error) {

      console.error(
        "ACCEPT BOOKING ERROR:",
        error
      );

      return res.status(409).json({
        ok: false,
        error:
          error.message ||
          "Booking could not be accepted."
      });
    }
  }
);
app.post(
  "/reject-booking",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const bookingId =
        String(req.body.bookingId || "").trim();

      if (!bookingId) {
        return res.status(400).json({
          ok: false,
          error: "bookingId is required."
        });
      }

      const db = admin.firestore();

      const masseuseSnapshot =
        await db
          .collection("masseuses")
          .where("uid", "==", req.user.uid)
          .limit(1)
          .get();

      if (masseuseSnapshot.empty) {
        return res.status(403).json({
          ok: false,
          error: "Masseuse account not found."
        });
      }

      const masseuse =
        masseuseSnapshot.docs[0].data();

      if (masseuse.employmentStatus !== "active") {
        return res.status(403).json({
          ok: false,
          error: "ACCOUNT_NOT_ACTIVE"
        });
      }

      const dispatchRef =
        db.collection("bookingDispatches")
          .doc(bookingId);

      const dispatchSnap =
        await dispatchRef.get();

      if (!dispatchSnap.exists) {
        return res.status(404).json({
          ok: false,
          error: "BOOKING_NOT_AVAILABLE"
        });
      }

      const dispatch =
        dispatchSnap.data();

      if (dispatch.poolId !== masseuse.poolId) {
        return res.status(403).json({
          ok: false,
          error: "WRONG_POOL"
        });
      }

      await dispatchRef.set(
        {
          rejectedByUids:
            admin.firestore.FieldValue.arrayUnion(
              req.user.uid
            )
        },
        {
          merge: true
        }
      );

      return res.json({
        ok: true
      });

    } catch (error) {

      console.error(
        "REJECT BOOKING ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Booking could not be rejected."
      });
    }
  }
);
app.get(
  "/private-session-note",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const bookingId =
        String(req.query.bookingId || "").trim();

      if (!bookingId) {
        return res.status(400).json({
          ok: false,
          error: "bookingId is required."
        });
      }

      const db = admin.firestore();

      const bookingSnap =
        await db
          .collection("bookings")
          .doc(bookingId)
          .get();

      if (!bookingSnap.exists) {
        return res.status(404).json({
          ok: false,
          error: "Booking not found."
        });
      }

      const booking =
        bookingSnap.data();

      if (
        booking.assignedMasseuseUid !==
        req.user.uid
      ) {
        return res.status(403).json({
          ok: false,
          error: "NOT_AUTHORIZED"
        });
      }

      const noteSnap =
        await db
          .collection("masseusePrivateNotes")
          .doc(bookingId)
          .get();

      return res.json({
        ok: true,
        note:
          noteSnap.exists
            ? String(noteSnap.data().note || "")
            : ""
      });

    } catch (error) {

      console.error(
        "GET PRIVATE NOTE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Private note could not be loaded."
      });
    }
  }
);


app.post(
  "/private-session-note",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const bookingId =
        String(req.body.bookingId || "").trim();

      const note =
        String(req.body.note || "").trim();

      if (!bookingId) {
        return res.status(400).json({
          ok: false,
          error: "bookingId is required."
        });
      }

      if (note.length > 2000) {
        return res.status(400).json({
          ok: false,
          error: "Note is too long."
        });
      }

      const db = admin.firestore();

      const bookingSnap =
        await db
          .collection("bookings")
          .doc(bookingId)
          .get();

      if (!bookingSnap.exists) {
        return res.status(404).json({
          ok: false,
          error: "Booking not found."
        });
      }

      const booking =
        bookingSnap.data();

      if (
        booking.assignedMasseuseUid !==
        req.user.uid
      ) {
        return res.status(403).json({
          ok: false,
          error: "NOT_AUTHORIZED"
        });
      }

      await db
        .collection("masseusePrivateNotes")
        .doc(bookingId)
        .set(
          {
            bookingId,
            masseuseUid: req.user.uid,
            note,
            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );

      return res.json({
        ok: true
      });

    } catch (error) {

      console.error(
        "SAVE PRIVATE NOTE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Private note could not be saved."
      });
    }
  }
);
app.get(
  "/masseuse-payout-profile",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const db = admin.firestore();

      const masseuseSnapshot =
        await db
          .collection("masseuses")
          .where("uid", "==", req.user.uid)
          .limit(1)
          .get();

      if (masseuseSnapshot.empty) {
        return res.status(403).json({
          ok: false,
          error: "Masseuse account not found."
        });
      }

      const profileSnap =
        await db
          .collection("masseusePayoutProfiles")
          .doc(req.user.uid)
          .get();

      return res.json({
        ok: true,
        profile:
          profileSnap.exists
            ? profileSnap.data()
            : null
      });

    } catch (error) {

      console.error(
        "GET PAYOUT PROFILE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Payout profile could not be loaded."
      });
    }
  }
);


app.post(
  "/masseuse-payout-profile",
  requireFirebaseAuth,
  async (req, res) => {

    try {

      const db = admin.firestore();

      const masseuseSnapshot =
        await db
          .collection("masseuses")
          .where("uid", "==", req.user.uid)
          .limit(1)
          .get();

      if (masseuseSnapshot.empty) {
        return res.status(403).json({
          ok: false,
          error: "Masseuse account not found."
        });
      }

      const masseuse =
        masseuseSnapshot.docs[0].data();

      if (
        masseuse.employmentStatus !== "active"
      ) {
        return res.status(403).json({
          ok: false,
          error: "ACCOUNT_NOT_ACTIVE"
        });
      }

      const payoutMethod =
        String(
          req.body.payoutMethod || ""
        ).trim();

      const accountHolder =
        String(
          req.body.accountHolder || ""
        ).trim();

      const bankName =
        String(
          req.body.bankName || ""
        ).trim();

      const accountReference =
        String(
          req.body.accountReference || ""
        ).trim();

      if (
        !payoutMethod ||
        !accountHolder ||
        !accountReference
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Required payout information is missing."
        });
      }

      if (
        payoutMethod.length > 50 ||
        accountHolder.length > 120 ||
        bankName.length > 120 ||
        accountReference.length > 100
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Payout information is too long."
        });
      }

      await db
        .collection("masseusePayoutProfiles")
        .doc(req.user.uid)
        .set(
          {
            masseuseUid:
              req.user.uid,

            payoutMethod,
            accountHolder,
            bankName,
            accountReference,

            updatedAt:
              admin.firestore.FieldValue
                .serverTimestamp()
          },
          {
            merge: true
          }
        );

      return res.json({
        ok: true
      });

    } catch (error) {

      console.error(
        "SAVE PAYOUT PROFILE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Payout profile could not be saved."
      });
    }
  }
);

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
if (position !== "Therapist") {
  return res.status(400).json({
    ok: false,
    error: "Only Therapist applications are accepted."
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