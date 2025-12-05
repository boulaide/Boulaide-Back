require("dotenv").config(); // Fixed: Must be the first line

const express = require("express");
const cors = require("cors");
const sql = require("mssql");
const bcrypt = require("bcrypt");
const { Resend } = require("resend");
const crypto = require("node:crypto");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3001";

const dbConfig = {
  user: "regio-admin",
  password: "regi0-adm1n!!",
  server: "boulaide.database.windows.net",
  database: "boulaide",
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000,
    requestTimeout: 30000,
  },
  pool: {
    max: 10,
    min: 1,
    idleTimeoutMillis: 30000,
  },
};

let globalPool;

sql
  .connect(dbConfig)
  .then((pool) => {
    globalPool = pool;
    console.log("Connected to Azure SQL");
    pool.on("error", (err) => {
      console.error("Connection pool error:", err);
    });
  })
  .catch((err) => {
    console.error("Error connecting to database:", err);
  });

async function getPool() {
  if (!globalPool) {
    globalPool = await sql.connect(dbConfig);
  }
  return globalPool;
}

async function createUser(username, email, password) {
  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const pool = await getPool();
    const result = await pool
      .request()
      .input("usernameParam", sql.VarChar(100), username)
      .input("emailParam", sql.VarChar(100), email)
      .input("passwordParam", sql.VarChar(256), hashedPassword)
      .input("tokenParam", sql.VarChar(255), verificationToken).query(`
                INSERT INTO dbo.users (username, email, password, is_verified, verification_token)
                OUTPUT INSERTED.user_id
                VALUES (@usernameParam, @emailParam, @passwordParam, 0, @tokenParam)
            `);

    await resend.emails.send({
      from: "not-reply@visit-boulaide.com",
      to: email,
      subject: "Confirm your account on Boulaide",
      html: `
        <p>Hello, ${username}!</p>
        <p>Thank you for registering. To activate your account, please click the link below:</p>
        <a href="${FRONTEND_URL}/verify-email?token=${verificationToken}">Confirm Account</a>
        <p>If you did not create this account, please ignore this email.</p>
      `,
    });

    return result.recordset[0];
  } catch (err) {
    console.error("Error creating user:", err);
    throw err;
  }
}

async function authenticateUser(email, password) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("emailParam", sql.VarChar(100), email).query(`
                SELECT * FROM dbo.users 
                WHERE email = @emailParam
            `);

    const user = result.recordset[0];
    if (!user) return null;

    if (user.is_verified === false) {
      throw new Error("Please confirm your email before logging in.");
    }

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      delete user.password;
      return user;
    }

    return null;
  } catch (err) {
    console.error("Error authenticating user:", err);
    throw err;
  }
}

async function verifyUserToken(token) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("tokenParam", sql.VarChar(255), token)
    .query(
      "SELECT user_id FROM dbo.users WHERE verification_token = @tokenParam"
    );

  const user = result.recordset[0];
  if (!user) return false;

  await pool
    .request()
    .input("userIdParam", sql.Int, user.user_id)
    .query(
      "UPDATE dbo.users SET is_verified = 1, verification_token = NULL WHERE user_id = @userIdParam"
    );

  return true;
}

async function createPasswordResetToken(email) {
  const pool = await getPool();

  const userResult = await pool
    .request()
    .input("emailParam", sql.VarChar(100), email)
    .query("SELECT user_id, username FROM dbo.users WHERE email = @emailParam");

  const user = userResult.recordset[0];
  if (!user) return null;

  const resetToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 3600000); // 1 hour

  await pool
    .request()
    .input("userIdParam", sql.Int, user.user_id)
    .input("tokenParam", sql.VarChar(255), resetToken)
    .input("expiresParam", sql.DateTime, expires)
    .query(
      "UPDATE dbo.users SET reset_token = @tokenParam, reset_token_expires = @expiresParam WHERE user_id = @userIdParam"
    );

  await resend.emails.send({
    from: "not-reply@visit-boulaide.com",
    to: email,
    subject: "Password Reset - Boulaide",
    html: `
        <p>Hello, ${user.username}.</p>
        <p>You requested a password reset. Click the link below to create a new password:</p>
        <a href="${FRONTEND_URL}/reset-password?token=${resetToken}">Reset Password</a>
        <p>This link expires in 1 hour.</p>
      `,
  });

  return true;
}

async function resetUserPassword(token, newPassword) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("tokenParam", sql.VarChar(255), token).query(`
            SELECT user_id FROM dbo.users 
            WHERE reset_token = @tokenParam 
            AND reset_token_expires > GETDATE()
        `);

  const user = result.recordset[0];
  if (!user) throw new Error("Invalid or expired token.");

  const saltRounds = 10;
  const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

  await pool
    .request()
    .input("userIdParam", sql.Int, user.user_id)
    .input("passwordParam", sql.VarChar(256), hashedPassword).query(`
            UPDATE dbo.users 
            SET password = @passwordParam, reset_token = NULL, reset_token_expires = NULL 
            WHERE user_id = @userIdParam
        `);

  return true;
}

async function updateUser(userId, updates) {
  const { username, email, currentPassword, newPassword } = updates;
  const pool = await getPool();
  let hashedPassword = null;

  if (newPassword) {
    if (!currentPassword) {
      throw new Error("Current password is required to set a new one.");
    }

    const userResult = await pool
      .request()
      .input("userIdParam", sql.Int, userId)
      .query("SELECT password FROM dbo.users WHERE user_id = @userIdParam");

    const user = userResult.recordset[0];
    if (!user) {
      throw new Error("User not found.");
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw new Error("Current password is incorrect.");
    }

    const saltRounds = 10;
    hashedPassword = await bcrypt.hash(newPassword, saltRounds);
  }

  const setClauses = [];
  const request = pool.request();
  request.input("userIdParam", sql.Int, userId);

  if (username) {
    setClauses.push("username = @usernameParam");
    request.input("usernameParam", sql.VarChar(100), username);
  }
  if (email) {
    setClauses.push("email = @emailParam");
    request.input("emailParam", sql.VarChar(100), email);
  }
  if (hashedPassword) {
    setClauses.push("password = @passwordParam");
    request.input("passwordParam", sql.VarChar(256), hashedPassword);
  }

  if (setClauses.length === 0) {
    return { message: "No data to update." };
  }

  const query = `UPDATE dbo.users SET ${setClauses.join(
    ", "
  )} WHERE user_id = @userIdParam`;
  await request.query(query);

  const updatedUser = await pool
    .request()
    .input("userIdParam", sql.Int, userId)
    .query(
      "SELECT user_id, username, email FROM dbo.users WHERE user_id = @userIdParam"
    );

  return updatedUser.recordset[0];
}

async function deleteUser(userId) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();
    const request = new sql.Request(transaction);
    request.input("userIdParam", sql.Int, userId);

    await request.query(
      "DELETE FROM dbo.user_customizations WHERE user_id = @userIdParam"
    );
    await request.query(
      "DELETE FROM dbo.user_stars WHERE user_id = @userIdParam"
    );
    await request.query(
      "DELETE FROM dbo.user_quests WHERE user_id = @userIdParam"
    );

    const result = await request.query(
      "DELETE FROM dbo.users WHERE user_id = @userIdParam"
    );

    await transaction.commit();
    return result.rowsAffected[0] > 0;
  } catch (err) {
    await transaction.rollback();
    console.error("Error in delete user transaction:", err);
    throw err;
  }
}

async function getCustomization(user_id) {
  try {
    const pool = await getPool();
    const result = await pool.request().input("userIdParam", sql.Int, user_id)
      .query(`
        SELECT c.*, uc.equipped
        FROM dbo.user_customizations uc
        INNER JOIN dbo.customizations c ON uc.customization_id = c.customization_id
        WHERE uc.user_id = @userIdParam
      `);
    return result.recordset;
  } catch (err) {
    console.error("Error fetching customizations:", err);
    throw err;
  }
}

async function addUserCustomization(
  user_id,
  customization_id,
  isEquipped = false
) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userIdParam", sql.Int, user_id)
      .input("customizationIdParam", sql.Int, customization_id)
      .input("equippedParam", sql.Bit, isEquipped).query(`
        IF NOT EXISTS (
          SELECT 1 FROM dbo.user_customizations 
          WHERE user_id = @userIdParam AND customization_id = @customizationIdParam
        )
        BEGIN
          INSERT INTO dbo.user_customizations (user_id, customization_id, equipped)
          VALUES (@userIdParam, @customizationIdParam, @equippedParam)
        END
      `);
    return result.rowsAffected[0] > 0;
  } catch (err) {
    console.error("Error adding customization:", err);
    throw err;
  }
}

async function addUserCustomizationSet(user_id, customization_ids) {
  try {
    if (!Array.isArray(customization_ids)) {
      throw new TypeError("customization_ids must be an array.");
    }

    const results = await Promise.all(
      customization_ids.map((id) => addUserCustomization(user_id, id, false))
    );

    return results.some(Boolean);
  } catch (err) {
    console.error("Error adding customization set:", err);
    throw err;
  }
}

async function getUserStars(user_id) {
  try {
    const pool = await getPool();
    const result = await pool.request().input("userIdParam", sql.Int, user_id)
      .query(`
        SELECT us.id AS star_id, us.user_id, q.quest_id, q.title, q.description, m.map
        FROM dbo.user_stars us
        INNER JOIN dbo.quests q ON us.quest_id = q.quest_id
        INNER JOIN dbo.maps m ON q.map_id = m.id
        WHERE us.user_id = @userIdParam
      `);

    return result.recordset.map((star) => ({
      star_id: star.star_id,
      user_id: star.user_id,
      quest: {
        id: star.quest_id,
        title: star.title,
        description: star.description,
        map: star.map,
      },
    }));
  } catch (err) {
    console.error("Error fetching stars:", err);
    throw err;
  }
}

async function addUserStar(user_id, quest_id) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userIdParam", sql.Int, user_id)
      .input("questIdParam", sql.Int, quest_id).query(`
        IF NOT EXISTS (
          SELECT 1 FROM dbo.user_stars
          WHERE user_id = @userIdParam AND quest_id = @questIdParam
        )
        BEGIN
          INSERT INTO dbo.user_stars (user_id, quest_id) VALUES (@userIdParam, @questIdParam)
        END       
      `);
    return result.rowsAffected[0] > 0;
  } catch (err) {
    console.error("Error adding star:", err);
    throw err;
  }
}

async function getUserQuests(user_id) {
  try {
    const pool = await getPool();
    const result = await pool.request().input("userIdParam", sql.Int, user_id)
      .query(`
        SELECT uq.user_id, uq.quest_id, uq.status, uq.user_description, uq.user_log_text,
               q.title, m.map
        FROM dbo.user_quests uq
        INNER JOIN dbo.quests q ON uq.quest_id = q.quest_id
        INNER JOIN dbo.maps m ON q.map_id = m.id
        WHERE uq.user_id = @userIdParam
      `);

    return result.recordset.map((quest) => ({
      user_id: quest.user_id,
      quest: {
        quest_id: quest.quest_id,
        title: quest.title,
        user_description: quest.user_description,
        user_log_text: quest.user_log_text,
        map: quest.map,
      },
      status: quest.status,
    }));
  } catch (err) {
    console.error("Error fetching user quests:", err);
    throw err;
  }
}

async function updateQuestStatus(user_id, quest_id, newStatus) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userIdParam", sql.Int, user_id)
      .input("questIdParam", sql.Int, quest_id)
      .input("newStatusParam", sql.Int, newStatus).query(`
        UPDATE dbo.user_quests
        SET status = @newStatusParam
        WHERE user_id = @userIdParam AND quest_id = @questIdParam
      `);

    return result.rowsAffected[0] > 0;
  } catch (err) {
    console.error("Error updating quest status:", err);
    throw err;
  }
}

async function assignQuestsToUser(user_id) {
  try {
    const pool = await getPool();

    const quests = await pool
      .request()
      .query("SELECT quest_id, description, log_text FROM dbo.quests");

    if (quests.recordset.length === 0) return;

    const queryValues = quests.recordset
      .map(
        (_, index) =>
          `(@userIdParam, @questIdParam${index}, 0, @descParam${index}, @logTextParam${index})`
      )
      .join(", ");

    const request = pool.request();
    request.input("userIdParam", sql.Int, user_id);

    quests.recordset.forEach((quest, index) => {
      request.input(`questIdParam${index}`, sql.Int, quest.quest_id);
      request.input(
        `descParam${index}`,
        sql.VarChar(sql.MAX),
        quest.description
      );
      request.input(
        `logTextParam${index}`,
        sql.VarChar(sql.MAX),
        quest.log_text
      );
    });

    const query = `
      INSERT INTO dbo.user_quests (user_id, quest_id, status, user_description, user_log_text)
      VALUES ${queryValues}
    `;

    await request.query(query);
  } catch (err) {
    console.error("Error assigning quests to user:", err);
    throw err;
  }
}

async function updateUserQuestDetails(
  user_id,
  quest_id,
  newDescription,
  newLogText
) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userIdParam", sql.Int, user_id)
      .input("questIdParam", sql.Int, quest_id)
      .input("descriptionParam", sql.VarChar(sql.MAX), newDescription)
      .input("logTextParam", sql.VarChar(sql.MAX), newLogText).query(`
        UPDATE dbo.user_quests
        SET user_description = @descriptionParam,
            user_log_text = @logTextParam
        WHERE user_id = @userIdParam AND quest_id = @questIdParam
      `);

    return result.rowsAffected[0] > 0;
  } catch (err) {
    console.error("Error updating user quest details:", err);
    throw err;
  }
}

app.post("/add-customization", async (req, res) => {
  try {
    const { user_id, customization_id } = req.body;

    if (!user_id || !customization_id)
      return res.status(400).json({ error: "Invalid parameters" });

    const success = await addUserCustomization(user_id, customization_id);

    if (success)
      return res.json({
        success: true,
        message: "Customization added successfully",
      });
    else return res.status(500).json({ error: "Error adding customization" });
  } catch (err) {
    console.log("Error in add-customization endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/add-customization-set", async (req, res) => {
  try {
    const { user_id, customization_ids } = req.body;

    if (
      !user_id ||
      !customization_ids ||
      !Array.isArray(customization_ids) ||
      customization_ids.length === 0
    ) {
      return res.status(400).json({
        error:
          "Invalid parameters. 'user_id' and 'customization_ids' (array) are required.",
      });
    }

    const success = await addUserCustomizationSet(user_id, customization_ids);

    if (success) {
      return res.json({
        success: true,
        message: "Customization set added successfully",
      });
    } else {
      return res.status(500).json({ error: "Error adding customization set" });
    }
  } catch (err) {
    console.log("Error in add-customization-set endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/inventory/equip", async (req, res) => {
  try {
    const { user_id, equipped_ids } = req.body;

    if (!user_id || !Array.isArray(equipped_ids)) {
      return res.status(400).json({
        error:
          "Invalid parameters. 'user_id' and 'equipped_ids' (array) are required.",
      });
    }

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    await transaction.begin();
    try {
      await transaction
        .request()
        .input("userIdParam", sql.Int, user_id)
        .query(
          "UPDATE dbo.user_customizations SET equipped = 0 WHERE user_id = @userIdParam"
        );

      if (equipped_ids.length > 0) {
        const idList = equipped_ids.map((id) => Number.parseInt(id)).join(",");

        await transaction
          .request()
          .input("userIdParam", sql.Int, user_id)
          .query(
            `UPDATE dbo.user_customizations SET equipped = 1 WHERE user_id = @userIdParam AND customization_id IN (${idList})`
          );
      }

      await transaction.commit();
      res.json({
        success: true,
        message: "Inventory updated successfully.",
      });
    } catch (err) {
      await transaction.rollback();
      console.error("Error in inventory update transaction:", err);
      res.status(500).json({ error: "Error updating inventory in database." });
    }
  } catch (err) {
    console.log("Error in equip item endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const newUser = await createUser(username, email, password);
    const defaultCustomizations = [64, 65, 66];
    for (const customizationId of defaultCustomizations) {
      await addUserCustomization(newUser.user_id, customizationId, true);
    }
    await assignQuestsToUser(newUser.user_id);
    const customizations = await getCustomization(newUser.user_id);
    const equippedItems = customizations.filter((item) => item.equipped);

    res.status(201).json({
      user_id: newUser.user_id,
      username: username,
      email: email,
      inventories: { inventory: customizations, equipped: equippedItems },
    });
  } catch (err) {
    console.error("Error in register:", err);
    if (
      err.number === 2627 ||
      (err.code === "EREQUEST" &&
        err.message.includes("Violation of UNIQUE KEY constraint"))
    ) {
      return res.status(409).json({ error: "Email already in use" });
    }
    res.status(500).json({ error: "Error creating user" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    const user = await authenticateUser(email, password);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const customizations = await getCustomization(user.user_id);
    const equippedItems = customizations.filter((item) => item.equipped);

    res.json({
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      inventories: { inventory: customizations, equipped: equippedItems },
    });
  } catch (err) {
    console.error("Error in login:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!id) {
      return res.status(400).json({ error: "User ID is required." });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No data to update." });
    }

    const updatedUser = await updateUser(
      Number.Number.parseInt(id, 10),
      updates
    );
    res.json({
      success: true,
      message: "Profile updated successfully.",
      user: updatedUser,
    });
  } catch (err) {
    console.error("Error in update user endpoint:", err);
    if (err.message === "Current password is incorrect.") {
      return res.status(403).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "User ID is required." });
    }

    const success = await deleteUser(Number.Number.parseInt(id, 10));

    if (success) {
      res
        .status(200)
        .json({ success: true, message: "User deleted successfully." });
    } else {
      res.status(404).json({ error: "User not found." });
    }
  } catch (err) {
    console.error("Error in delete user endpoint:", err);
    res.status(500).json({ error: "Internal error deleting user." });
  }
});

app.get("/inventory/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id)
      return res
        .status(400)
        .json({ success: false, message: "Missing id parameter" });

    const customizations = await getCustomization(id);
    const equippedItems = customizations.filter((item) => item.equipped);

    res.json({
      equipped: equippedItems,
      inventory: customizations,
    });
  } catch (err) {
    console.error("Error querying Azure SQL:", err);
    res.status(500).send("Error querying database");
  }
});

app.get("/stars/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id)
      return res
        .status(400)
        .json({ success: false, message: "Missing id parameter" });

    const stars = await getUserStars(id);

    res.json(stars);
  } catch (err) {
    console.error("Error querying Azure SQL:", err);
    res.status(500).send("Error querying database");
  }
});

app.post("/add-user-star", async (req, res) => {
  try {
    const { user_id, quest_id } = req.body;

    if (user_id === undefined || quest_id === undefined)
      return res.status(400).json({
        error: "Invalid parameters: user_id and quest_id are required.",
      });

    const userIdNum = Number.parseInt(user_id, 10);
    const questIdNum = Number.parseInt(quest_id, 10);

    if (Number.isNaN(userIdNum) || Number.isNaN(questIdNum)) {
      return res
        .status(400)
        .json({ error: "Parameters user_id and quest_id must be numbers." });
    }

    const success = await addUserStar(userIdNum, questIdNum);

    if (success)
      return res.json({
        success: true,
        message: "Star added successfully",
      });
    else {
      console.log(
        `Attempt to add existing star or insert failure: user_id=${userIdNum}, quest_id=${questIdNum}`
      );
      return res.status(304).json({
        success: false,
        message: "User already has this star or error adding it.",
      });
    }
  } catch (err) {
    console.log("Error in add star endpoint:", err);
    res.status(500).json({
      error: "Internal server error adding star.",
      details: err.message,
    });
  }
});

app.get("/user-quests/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id)
      return res
        .status(400)
        .json({ success: false, message: "Missing id parameter" });

    const userQuests = await getUserQuests(Number.parseInt(id, 10));
    res.json(userQuests);
  } catch (err) {
    console.error("Error in /user-quests/:id endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/user-quests/:user_id/:quest_id", async (req, res) => {
  try {
    const { user_id, quest_id } = req.params;
    const { description, log_text } = req.body;

    if (
      !user_id ||
      !quest_id ||
      description === undefined ||
      log_text === undefined
    ) {
      return res.status(400).json({
        error:
          "Invalid parameters: user ID, quest ID, description, and log_text are required.",
      });
    }

    const userId = Number.parseInt(user_id, 10);
    const questId = Number.parseInt(quest_id, 10);

    const successDetails = await updateUserQuestDetails(
      userId,
      questId,
      description,
      log_text
    );
    let successStatus = true;

    if (successDetails || successStatus) {
      return res.json({
        success: true,
        message: `Quest with ID ${questId} for user ${userId} updated successfully.`,
      });
    } else {
      return res.status(404).json({
        error: `Quest with ID ${questId} for user ${userId} not found or update error.`,
      });
    }
  } catch (err) {
    console.error("Error updating user quest details:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/user-quests-status", async (req, res) => {
  try {
    const { user_id, quest_id, newStatus } = req.body;
    console.log(user_id, quest_id, newStatus);
    if (!user_id || !quest_id || newStatus === undefined)
      return res.status(400).json({ error: "Invalid parameters" });

    const success = await updateQuestStatus(user_id, quest_id, newStatus);

    if (success)
      return res.json({
        success: true,
        message: "Quest status changed successfully",
      });
    else return res.status(500).json({ error: "Error changing quest status" });
  } catch (err) {
    console.log("Error in change quest status endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/quests/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { description, log_text } = req.body;

    if (!id || description === undefined || log_text === undefined) {
      return res.status(400).json({
        error:
          "Invalid parameters: quest ID, description, and log_text are required.",
      });
    }

    const questId = Number.parseInt(id, 10);

    const success = await updateUserQuestDetails(
      questId,
      description,
      log_text
    );

    if (success) {
      return res.json({
        success: true,
        message: `Quest with ID ${questId} updated successfully.`,
      });
    } else {
      return res.status(404).json({
        error: `Quest with ID ${questId} not found or update error.`,
      });
    }
  } catch (err) {
    console.error("Error updating quest details:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/verify-email", async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) return res.status(400).send("<h1>Error: Token required</h1>");

    const success = await verifyUserToken(token);

    if (success) {
      res.send(`
        <html>
          <head><title>Account Verified</title></head>
          <body style="font-family: Arial; text-align: center; padding-top: 50px;">
            <h1 style="color: green;">Success!</h1>
            <p>Your account has been successfully verified.</p>
            <p>You can now close this window and log in to the application.</p>
          </body>
        </html>
      `);
    } else {
      res.status(400).send("<h1>Error: Invalid or expired token.</h1>");
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("<h1>Internal error verifying account.</h1>");
  }
});

app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    await createPasswordResetToken(email);

    res.json({
      success: true,
      message: "If the email exists, instructions have been sent.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error." });
  }
});

app.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res
        .status(400)
        .json({ error: "Token and new password are required." });
    }

    await resetUserPassword(token, newPassword);

    res.json({ success: true, message: "Password changed successfully." });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get("/", async (req, res) => {
  return res.json({ success: "api connected" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`\n\nServer is running on port ${port}`);
});
