const fetch = require('node-fetch');

async function testTTS() {
    for (let i = 1; i <= 2; i++) {
        console.log(`Test ${i}: Sending request to /speak...`);
        try {
            const response = await fetch('http://localhost:3001/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: `Это тестовое сообщение номер ${i}` })
            });
            console.log(`Test ${i}: Status: ${response.status}`);
            if (response.status !== 200) {
                const text = await response.text();
                console.log(`Test ${i}: Error: ${text}`);
            } else {
                console.log(`Test ${i}: Success!`);
            }
        } catch (error) {
            console.log(`Test ${i}: Request failed: ${error.message}`);
        }
    }
}

testTTS();
