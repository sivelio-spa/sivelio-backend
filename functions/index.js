const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

/*
👉 BU: bir kullanıcıyı admin yapar
*/
exports.setAdmin = functions.https.onCall(async (data, context) => {

  const email = data.email;

  if (!email) {
    throw new functions.https.HttpsError("invalid-argument", "Email gerekli");
  }

  const user = await admin.auth().getUserByEmail(email);

  await admin.auth().setCustomUserClaims(user.uid, {
    admin: true
  });

  return { message: email + " admin yapıldı" };
});