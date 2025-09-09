const express = require("express");
const cors = require("cors");
const sql = require("mssql");

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  user: "regio-admin",
  password: "regi0-adm1n!!",
  server: "boulaide.database.windows.net",
  database: "boulaide",
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000, // Increase timeout to 30 sec
    requestTimeout: 30000, // Timeout for requests
  },
  pool: {
    max: 10, // Maximum number of connections in pool
    min: 1,
    idleTimeoutMillis: 30000, // Time to close idle connections
  },
};

// Global variable to store the connection pool
let globalPool;

// Initialize the connection pool once when the server starts
sql
  .connect(dbConfig)
  .then((pool) => {
    globalPool = pool;
    console.log("Conectado ao Azure SQL");
    pool.on("error", (err) => {
      console.error("Erro no pool de conexões:", err);
    });
  })
  .catch((err) => {
    console.error("Erro ao conectar ao banco:", err);
  });

// Helper function that waits for the pool to be ready
async function getPool() {
  if (!globalPool) {
    globalPool = await sql.connect(dbConfig);
  }
  return globalPool;
}

async function createUser(username, email, password) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("usernameParam", sql.VarChar(100), username)
      .input("emailParam", sql.VarChar(100), email)
      .input("passwordParam", sql.VarChar(256), password).query(`
        INSERT INTO dbo.users (username, email, password)
        OUTPUT INSERTED.user_id
        VALUES (@usernameParam, @emailParam, @passwordParam)
      `);
    return result.recordset[0];
  } catch (err) {
    console.error("Erro ao criar usuário:", err);
    throw err;
  }
}

async function getUserByCredentials(email, password) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("emailParam", sql.VarChar(100), email)
      .input("passwordParam", sql.VarChar(256), password).query(`
        SELECT * FROM dbo.users 
        WHERE email = @emailParam AND password = @passwordParam
      `);
    return result.recordset[0];
  } catch (err) {
    console.error("Erro ao buscar usuário:", err);
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
    console.error("Erro ao buscar customizações:", err);
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
          -- Inserimos o valor de 'equipped'
          INSERT INTO dbo.user_customizations (user_id, customization_id, equipped)
          VALUES (@userIdParam, @customizationIdParam, @equippedParam)
        END
      `);
    return result.rowsAffected[0] > 0;
  } catch (err) {
    console.error("Erro ao adicionar customização:", err);
    throw err;
  }
}

async function addUserCustomizationSet(user_id, customization_ids) {
  try {
    if (!Array.isArray(customization_ids)) {
      throw new Error("customization_ids precisa ser um array.");
    }

    const results = await Promise.all(
      customization_ids.map((id) => addUserCustomization(user_id, id, false))
    );

    return results.some((success) => success);
  } catch (err) {
    console.error("Erro ao adicionar conjunto de customizações:", err);
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
    console.error("Erro ao buscar estrelas:", err);
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
    console.error("Erro ao adicionar estrela:", err);
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
    console.error("Erro ao buscar questões do usuário:", err);
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

    // Retorna true se pelo menos uma linha foi afetada
    return result.rowsAffected[0] > 0;
  } catch (err) {
    console.error("Erro ao atualizar o status da quest:", err);
    throw err;
  }
}

async function assignQuestsToUser(user_id) {
  try {
    const pool = await getPool();

    // Buscar todas as quests com description e log_text
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
    console.error("Erro ao associar quests ao usuário:", err);
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
    console.error("Erro ao atualizar detalhes da quest do usuário:", err);
    throw err;
  }
}

app.post("/add-customization", async (req, res) => {
  try {
    const { user_id, customization_id } = req.body;

    if (!user_id || !customization_id)
      return res.status(400).json({ error: "Parâmetros inválidos" });

    const success = await addUserCustomization(user_id, customization_id);

    if (success)
      return res.json({
        success: true,
        message: "Customização adicionada com sucesso",
      });
    else
      return res.status(500).json({ error: "Erro ao adicionar customização" });
  } catch (err) {
    console.log("Erro no endpoint de adicionar customização:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/add-customization-set", async (req, res) => {
  try {
    const { user_id, customization_ids } = req.body;

    if (!user_id || !customization_ids || !Array.isArray(customization_ids) || customization_ids.length === 0) {
      return res.status(400).json({ error: "Parâmetros inválidos. 'user_id' e 'customization_ids' (array) são necessários." });
    }

    const success = await addUserCustomizationSet(user_id, customization_ids);

    if (success) {
      return res.json({
        success: true,
        message: "Conjunto de customizações adicionado com sucesso",
      });
    } else {
       return res.status(500).json({ error: "Erro ao adicionar conjunto de customizações" });
    }
  } catch (err) {
    console.log("Erro no endpoint de adicionar conjunto de customizações:", err);
    res.status(500).json({ error: err.message });
  }
});


app.put("/inventory/equip", async (req, res) => {
  try {
    const { user_id, equipped_ids } = req.body;

    if (!user_id || !Array.isArray(equipped_ids)) {
      return res
        .status(400)
        .json({
          error:
            "Parâmetros inválidos. 'user_id' e 'equipped_ids' (array) são necessários.",
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
        const idList = equipped_ids.map((id) => parseInt(id)).join(",");

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
        message: "Inventário atualizado com sucesso.",
      });
    } catch (err) {
      await transaction.rollback();
      console.error("Erro na transação de atualização do inventário:", err);
      res
        .status(500)
        .json({ error: "Erro ao atualizar o inventário no banco de dados." });
    }
  } catch (err) {
    console.log("Erro no endpoint de equipar item:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ error: "Todos os campos são obrigatórios" });
    }

    const newUser = await createUser(username, email, password);

    const defaultCustomizations = [5, 6, 7];
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
      inventories: {
        inventory: customizations,
        equipped: equippedItems,
      },
    });
  } catch (err) {
    console.error("Erro no registro:", err);
    if (
      err.number === 2627 ||
      (err.code === "EREQUEST" &&
        err.message.includes("Violation of UNIQUE KEY constraint"))
    ) {
      return res.status(400).json({ error: "Email já está em uso" });
    }
    res.status(500).json({ error: "Erro ao criar usuário" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Credenciais faltando" });
    }

    const user = await getUserByCredentials(email, password);
    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const customizations = await getCustomization(user.user_id);
    const equippedItems = customizations.filter((item) => item.equipped);

    res.json({
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      inventories: {
        inventory: customizations,
        equipped: equippedItems,
      },
    });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ error: err.message });
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
      // Check for undefined as well
      return res.status(400).json({
        error: "Parâmetros inválidos: user_id e quest_id são obrigatórios.",
      });

    const userIdNum = parseInt(user_id, 10);
    const questIdNum = parseInt(quest_id, 10);

    if (isNaN(userIdNum) || isNaN(questIdNum)) {
      return res
        .status(400)
        .json({ error: "Parâmetros user_id e quest_id devem ser números." });
    }

    const success = await addUserStar(userIdNum, questIdNum);

    if (success)
      return res.json({
        success: true,
        message: "Estrela adicionada com sucesso",
      });
    else {
      console.log(
        `Tentativa de adicionar estrela que já existe ou falha na inserção: user_id=${userIdNum}, quest_id=${questIdNum}`
      );
      return res.status(304).json({
        success: false,
        message: "Usuário já possui esta estrela ou erro ao adicionar.",
      });
    }
  } catch (err) {
    console.log("Erro no endpoint de adicionar estrela:", err);
    res.status(500).json({
      error: "Erro interno do servidor ao adicionar estrela.",
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

    const userQuests = await getUserQuests(parseInt(id, 10));
    res.json(userQuests);
  } catch (err) {
    console.error("Erro no endpoint /user-quests/:id:", err);
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
          "Parâmetros inválidos: user ID, quest ID, description e log_text são obrigatórios.",
      });
    }

    const userId = parseInt(user_id, 10);
    const questId = parseInt(quest_id, 10);

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
        message: `Quest com ID ${questId} do usuário ${userId} atualizada com sucesso.`,
      });
    } else {
      return res.status(404).json({
        error: `Quest com ID ${questId} do usuário ${userId} não encontrada ou erro na atualização.`,
      });
    }
  } catch (err) {
    console.error("Erro ao atualizar detalhes da quest do usuário:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/user-quests-status", async (req, res) => {
  try {
    const { user_id, quest_id, newStatus } = req.body;
    console.log(user_id, quest_id, newStatus);
    if (!user_id || !quest_id || newStatus === undefined)
      return res.status(400).json({ error: "Parâmetros inválidos" });

    const success = await updateQuestStatus(user_id, quest_id, newStatus);

    if (success)
      return res.json({
        success: true,
        message: "Status da quest mudado com sucesso",
      });
    else
      return res.status(500).json({ error: "Erro ao mudar o status da quest" });
  } catch (err) {
    console.log("Erro no endpoint de mudar o status da quest:", err);
    res.status(500).json({ error: err.message });
  }
});

// New route to update description and log_text in dbo.quests
app.put("/quests/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { description, log_text } = req.body;

    if (!id || description === undefined || log_text === undefined) {
      return res.status(400).json({
        error:
          "Parâmetros inválidos: quest ID, description e log_text são obrigatórios.",
      });
    }

    const questId = parseInt(id, 10);

    const success = await updateUserQuestDetails(
      questId,
      description,
      log_text
    );

    if (success) {
      return res.json({
        success: true,
        message: `Quest com ID ${questId} atualizada com sucesso.`,
      });
    } else {
      return res.status(404).json({
        error: `Quest com ID ${questId} não encontrada ou erro na atualização.`,
      });
    }
  } catch (err) {
    console.error("Erro ao atualizar detalhes da quest:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", async (req, res) => {
  return res.json({ success: "api connected" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`\n\nServer is running on port ${port}`);
});
