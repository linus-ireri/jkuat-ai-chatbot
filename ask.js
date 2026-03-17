import fetch from "node-fetch";
import readline from "readline";

// Create an input interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("Ask your question: ", async (question) => {
  try {
    const response = await fetch("http://localhost:3001/rag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question })
    });

    const data = await response.json();

    console.log("\n💬 Answer:");
    console.log(data.answer || JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    rl.close();
  }
});
