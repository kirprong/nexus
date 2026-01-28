const { Client } = require("@gradio/client");

async function test() {
    try {
        const client = await Client.connect("Qwen/Qwen-TTS-Demo");
        const info = await client.view_api();
        console.log(JSON.stringify(info, null, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
