const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const IMAGE_DIR = path.join(__dirname, "images");

fs.mkdirSync(IMAGE_DIR, { recursive: true });

app.use("/images", express.static(IMAGE_DIR));

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "uonzu-api",
    message: "雨温図作成API is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true
  });
});

app.post("/uonzu", async (req, res) => {
  let browser = null;

  try {
    const {
      city,
      temperatures,
      precipitation,
      latitude,
      longitude,
      temperature_min,
      temperature_max,
      precipitation_max,
      auto_axis = false,
      source = "",
      normal_period = ""
    } = req.body;

    // -------------------------
    // 入力チェック
    // -------------------------

    if (typeof city !== "string" || city.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "city が必要です。"
      });
    }

    if (
      !Array.isArray(temperatures) ||
      temperatures.length !== 12
    ) {
      return res.status(400).json({
        success: false,
        message: "temperatures は1月～12月の12個の数値が必要です。"
      });
    }

    if (
      !Array.isArray(precipitation) ||
      precipitation.length !== 12
    ) {
      return res.status(400).json({
        success: false,
        message: "precipitation は1月～12月の12個の数値が必要です。"
      });
    }

    const tempValues = temperatures.map(Number);
    const rainValues = precipitation.map(Number);

    if (tempValues.some(v => !Number.isFinite(v))) {
      return res.status(400).json({
        success: false,
        message: "temperatures に数値以外が含まれています。"
      });
    }

    if (rainValues.some(v => !Number.isFinite(v))) {
      return res.status(400).json({
        success: false,
        message: "precipitation に数値以外が含まれています。"
      });
    }

    // -------------------------
    // Playwright起動
    // -------------------------

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1400,
        height: 1000
      },
      deviceScaleFactor: 1
    });

    const page = await context.newPage();

    // alertが出た場合に自動で閉じる
    page.on("dialog", async dialog => {
      console.log("Dialog:", dialog.message());
      await dialog.dismiss();
    });

    // -------------------------
    // 谷謙二研究室 雨温図作成サイト
    // -------------------------

    await page.goto(
      "https://ktgis.net/service/uonzu/index.html",
      {
        waitUntil: "networkidle",
        timeout: 60000
      }
    );

    await page.waitForSelector("#temp", {
      timeout: 30000
    });

    await page.waitForSelector("#rain", {
      timeout: 30000
    });

    // -------------------------
    // 地点情報
    // -------------------------

    await page.locator("#placeName").fill(city.trim());

    if (
      latitude !== undefined &&
      latitude !== null &&
      latitude !== ""
    ) {
      await page.locator("#lat").fill(String(latitude));
    } else {
      await page.locator("#lat").fill("");
    }

    if (
      longitude !== undefined &&
      longitude !== null &&
      longitude !== ""
    ) {
      await page.locator("#lon").fill(String(longitude));
    } else {
      await page.locator("#lon").fill("");
    }

    // -------------------------
    // 12か月データ
    // サイト仕様どおり改行区切り
    // -------------------------

    await page.locator("#temp").fill(
      tempValues.join("\n")
    );

    await page.locator("#rain").fill(
      rainValues.join("\n")
    );

    // -------------------------
    // 雨温図を選択
    // -------------------------

    await page.locator("#uon").check();

    // -------------------------
    // 縦軸設定
    // -------------------------

    const autoAxis = Boolean(auto_axis);

    if (autoAxis) {
      await page.locator("#autoVertivalLine").check();
    } else {
      await page.locator("#autoVertivalLine").uncheck();

      // 値が指定されていなければ、
      // データ範囲から見やすい値を決定する。

      const maxRainValue = Math.max(...rainValues);
      const maxTempValue = Math.max(...tempValues);
      const minTempValue = Math.min(...tempValues);

      const calculatedRainMax =
        (Math.floor(maxRainValue / 100) + 1) * 100;

      const calculatedTempMax =
        maxTempValue < 0
          ? 0
          : (Math.floor(maxTempValue / 10) + 1) * 10;

      const calculatedTempMin =
        minTempValue >= 0
          ? 0
          : (Math.floor(minTempValue / 10) - 1) * 10;

      const rainMax =
        Number.isFinite(Number(precipitation_max))
          ? Number(precipitation_max)
          : calculatedRainMax;

      const tempMax =
        Number.isFinite(Number(temperature_max))
          ? Number(temperature_max)
          : calculatedTempMax;

      const tempMin =
        Number.isFinite(Number(temperature_min))
          ? Number(temperature_min)
          : calculatedTempMin;

      if (tempMax <= tempMin) {
        throw new Error(
          "temperature_max は temperature_min より大きくしてください。"
        );
      }

      if (rainMax <= 0) {
        throw new Error(
          "precipitation_max は0より大きくしてください。"
        );
      }

      await page.locator("#maxRain").fill(
        String(rainMax)
      );

      await page.locator("#maxTemp").fill(
        String(tempMax)
      );

      await page.locator("#minTemp").fill(
        String(tempMin)
      );
    }

    // -------------------------
    // サイトの「表示」を実行
    // -------------------------

    await page.locator(
      'input[name="btnGo"]'
    ).click();

    // show_graph() は最後に
    //
    // canvasimage.src = popcanvas.toDataURL()
    //
    // を実行する。
    //
    // つまり #canvasimage に入ったdata URLが
    // サイト自身が生成した実際の雨温図画像。
    // -------------------------

    await page.waitForFunction(() => {
      const img =
        document.getElementById("canvasimage");

      return (
        img &&
        typeof img.src === "string" &&
        img.src.startsWith("data:image/") &&
        img.complete &&
        img.naturalWidth > 0 &&
        img.naturalHeight > 0
      );
    }, {
      timeout: 30000
    });

    // -------------------------
    // サイト生成PNGを直接取得
    // 独自にグラフを描き直さない
    // -------------------------

    const imageDataUrl = await page
      .locator("#canvasimage")
      .getAttribute("src");

    if (
      !imageDataUrl ||
      !imageDataUrl.startsWith("data:image/")
    ) {
      throw new Error(
        "雨温図作成サイトから生成画像を取得できませんでした。"
      );
    }

    const match = imageDataUrl.match(
      /^data:image\/png;base64,(.+)$/
    );

    if (!match) {
      throw new Error(
        "サイト生成画像がPNG形式ではありませんでした。"
      );
    }

    const pngBuffer = Buffer.from(
      match[1],
      "base64"
    );

    // PNG署名確認
    if (
      pngBuffer.length < 8 ||
      pngBuffer[0] !== 0x89 ||
      pngBuffer[1] !== 0x50 ||
      pngBuffer[2] !== 0x4e ||
      pngBuffer[3] !== 0x47
    ) {
      throw new Error(
        "取得したデータが有効なPNGではありません。"
      );
    }

    // -------------------------
    // ファイル保存
    // -------------------------

    const id = crypto.randomUUID();

    const filename =
      `uonzu-${id}.png`;

    const filepath =
      path.join(IMAGE_DIR, filename);

    fs.writeFileSync(
      filepath,
      pngBuffer
    );

    // -------------------------
    // 公開URL
    // Render等のホスト名を自動取得
    // -------------------------

    const forwardedProto =
      req.headers["x-forwarded-proto"];

    const protocol =
      forwardedProto
        ? forwardedProto.split(",")[0]
        : req.protocol;

    const host =
      req.get("host");

    const imageUrl =
      `${protocol}://${host}/images/${filename}`;

    // -------------------------
    // 実際に使用された軸を取得
    // -------------------------

    const usedAxis = await page.evaluate(() => ({
      precipitation_max:
        Number(
          document.getElementById("maxRain").value
        ),
      temperature_max:
        Number(
          document.getElementById("maxTemp").value
        ),
      temperature_min:
        Number(
          document.getElementById("minTemp").value
        )
    }));

    await browser.close();
    browser = null;

    return res.json({
      success: true,

      city: city.trim(),

      image_url: imageUrl,

      source_url:
        "https://ktgis.net/service/uonzu/index.html",

      image_origin:
        "谷謙二研究室 雨温図作成サイト上で生成されたPNG",

      data_source: source,

      normal_period: normal_period,

      axis: usedAxis,

      message:
        "雨温図作成サイト上で実際に生成されたPNGを取得しました。"
    });

  } catch (error) {

    console.error(error);

    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }

    return res.status(500).json({
      success: false,
      message:
        error && error.message
          ? error.message
          : "雨温図の作成に失敗しました。"
    });
  }
});

// -------------------------
// 起動
// -------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `uonzu-api running on port ${PORT}`
  );
});
