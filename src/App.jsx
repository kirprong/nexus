import React, { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';

// --- CONFIG ---
const SOCKET_URL = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

const NexusChat = () => {
    const [messages, setMessages] = useState([
        { role: 'system_display', content: 'System initialized. Nexus Core online.' }
    ]);
    const [isLoading, setIsLoading] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [socketConnected, setSocketConnected] = useState(false);

    const messagesEndRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const socketRef = useRef(null);
    const typewriterRef = useRef(null); // To manage typing interval 

    // --- AUDIO QUEUE SYSTEM ---
    const audioQueueRef = useRef({}); // Using object for indexed storage
    const isPlayingRef = useRef(false);
    const nextExpectedIndexRef = useRef(0); // Sequence tracker
    const currentAudioRef = useRef(null); // To stop audio if needed
    const fillerAudioRef = useRef(null); // Reference for filler audio
    const fillerFilesRef = useRef([]); // Store original list of filler files
    const fillerQueueRef = useRef([]); // Shuffled queue of fillers to play
    const isWaitingForResponseRef = useRef(false); // Ref to track waiting state for fillers
    const isInterruptedRef = useRef(false); // Track interruption state

    // Initial connection to Socket.io
    useEffect(() => {
        socketRef.current = io(SOCKET_URL);

        socketRef.current.on('connect', () => {
            console.log("Socket connected");
            setSocketConnected(true);
        });

        socketRef.current.on('disconnect', () => {
            console.log("Socket disconnected");
            setSocketConnected(false);
        });

        // Load filler files
        fetch(`${SOCKET_URL}/fillers`)
            .then(res => res.json())
            .then(files => {
                fillerFilesRef.current = files;
                console.log("Loaded filler files:", files);
            })
            .catch(err => console.error("Failed to load fillers:", err));


        // --- REAL-TIME STREAMING EVENTS ---

        // 1. TEXT STREAM (Ignored for display now, only used to ensure assistant bubble exists)
        socketRef.current.on('text_chunk', (chunk) => {
            if (isInterruptedRef.current) return; // Internet silence

            setMessages(prev => {
                // Ensure there is an assistant message bubble to type into later
                const lastMsg = prev[prev.length - 1];
                if (!lastMsg || lastMsg.role !== 'assistant') {
                    // Add a placeholder that we will fill with the synchronized text
                    return [...prev, { role: 'assistant', content: '', isFinal: false }];
                }
                return prev;
            });
            // We do NOT append text here anymore. We wait for audio_chunk.
        });

        // 2. AUDIO STREAM
        socketRef.current.on('audio_chunk', (data) => {
            if (isInterruptedRef.current) return;

            // Stop fillers only when the FIRST chunk (index 0) arrives
            if (data.index === 0) {
                isWaitingForResponseRef.current = false;
                stopFillerSound();
            }

            let blob = null;
            if (data.audio) {
                try {
                    const byteCharacters = atob(data.audio);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    blob = new Blob([byteArray], { type: 'audio/webm' });
                } catch (e) {
                    console.error("Failed to decode audio base64", e);
                }
            }

            audioQueueRef.current[data.index] = { blob, text: data.text };

            if (!isPlayingRef.current) {
                playNextAudio();
            }
        });

        socketRef.current.on('stream_end', () => {
            if (isInterruptedRef.current) return;
            setIsLoading(false);

            // Safety: stop fillers if they are still playing somehow
            isWaitingForResponseRef.current = false;
            stopFillerSound();

            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    return [...prev.slice(0, -1), { ...lastMsg, isFinal: true }];
                }
                return prev;
            });
        });

        socketRef.current.on('error', (err) => {
            if (isInterruptedRef.current) return;
            console.error("Socket Error:", err);
            isWaitingForResponseRef.current = false;
            stopFillerSound();
            setMessages(prev => [...prev, { role: 'system_error', content: `Error: ${err}` }]);
            setIsLoading(false);
        });

        return () => {
            socketRef.current.disconnect();
            if (typewriterRef.current) clearInterval(typewriterRef.current);
        };
    }, []);

    // --- AUDIO PLAYBACK LOGIC ---
    // (queueAudio is no longer used directly from outside, but we keep structure if needed)

    const playNextAudio = async () => {
        const index = nextExpectedIndexRef.current;
        const item = audioQueueRef.current[index]; // item is { blob, text }

        if (!item) {
            isPlayingRef.current = false;
            return;
        }

        const { blob, text } = item;
        isPlayingRef.current = true;
        delete audioQueueRef.current[index];
        nextExpectedIndexRef.current++;

        const handleEnd = () => {
            currentAudioRef.current = null;
            if (typewriterRef.current) clearInterval(typewriterRef.current);
            playNextAudio();
        };

        if (blob) {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.playbackRate = 1.2; // Speed up audio 1.2x
            currentAudioRef.current = audio;

            audio.onended = () => {
                URL.revokeObjectURL(url);
                handleEnd();
            };

            audio.onerror = (e) => {
                console.error("Audio playback error", e);
                URL.revokeObjectURL(url);
                // Fallback to Browser TTS
                speakWithBrowser(text, handleEnd);
            };

            try {
                await audio.play();
                const duration = audio.duration;
                // Since audio plays 1.5x faster, the typewriter duration must be divided by 1.5
                const typingSpeedMultiplier = 0.93 / 1.2;
                const validDuration = (duration && duration !== Infinity && !isNaN(duration))
                    ? (duration * 1000) * typingSpeedMultiplier
                    : (text.length * (54 / 1.2));

                startTypewriter(text, Math.max(0, validDuration - 50));
            } catch (e) {
                console.error("Autoplay failed", e);
                speakWithBrowser(text, handleEnd);
            }
        } else {
            // Text-only signal from server -> Use Browser TTS
            speakWithBrowser(text, handleEnd);
        }
    };

    const speakWithBrowser = async (text, onDone) => {
        // Client-side Edge TTS spoofing is blocked by CORS origin policies in Chrome.
        // We revert to robust native synthesis as the primary fallback for all browsers.
        fallbackToNative(text, onDone);
    };

    const fallbackToNative = (text, onDone) => {
        if (!window.speechSynthesis) {
            startTypewriter(text, text.length * 38); // Pre-calculated for ~1.2x speed
            setTimeout(onDone, text.length * 38 + 100);
            return;
        }

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ru-RU';
        utterance.rate = 1.2; // Speed up native TTS 1.2x

        const voices = window.speechSynthesis.getVoices();
        // Priority: Microsoft Dmitry (Edge/Win) > Google Russian (Chrome) > Any Russian
        const russianVoice =
            voices.find(v => v.lang === 'ru-RU' && v.name.includes('Dmitry')) ||
            voices.find(v => v.lang === 'ru-RU' && v.name.includes('Google')) ||
            voices.find(v => v.lang.startsWith('ru')) ||
            voices[0];

        if (russianVoice) utterance.voice = russianVoice;
        // Estimated duration for typewriter adjusted for 1.2x
        utterance.onstart = () => startTypewriter(text, text.length * 50);
        utterance.onend = onDone;
        window.speechSynthesis.speak(utterance);
    };

    const startTypewriter = (textToType, durationMs) => {
        const startTime = Date.now();
        const totalChars = textToType.length;
        let charIndex = 0;
        const updateInterval = 30; // 30ms updates for smoothness

        if (typewriterRef.current) clearInterval(typewriterRef.current);

        typewriterRef.current = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const targetIndex = Math.floor(progress * totalChars);

            if (targetIndex > charIndex) {
                const charsToAdd = textToType.substring(charIndex, targetIndex);

                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.role === 'assistant') {
                        return [...prev.slice(0, -1), {
                            ...lastMsg,
                            content: lastMsg.content + charsToAdd
                        }];
                    } else {
                        // Create if somehow missing
                        return [...prev, { role: 'assistant', content: charsToAdd, isFinal: false }];
                    }
                });
                scrollToBottom();
                charIndex = targetIndex;
            }

            if (progress >= 1) {
                clearInterval(typewriterRef.current);
                // Flush remaining
                if (charIndex < totalChars) {
                    const remaining = textToType.substring(charIndex);
                    setMessages(prev => {
                        const lastMsg = prev[prev.length - 1];
                        if (lastMsg && lastMsg.role === 'assistant') {
                            return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + remaining }];
                        }
                        return prev;
                    });
                    scrollToBottom();
                }
            }
        }, updateInterval);
    };


    const playFillerSound = () => {
        if (!isWaitingForResponseRef.current || fillerFilesRef.current.length === 0) {
            console.log("Not playing filler: waiting:", isWaitingForResponseRef.current, "count:", fillerFilesRef.current.length);
            return;
        }

        if (fillerAudioRef.current) {
            console.log("Filler already playing, skipping overlap");
            return; // Don't stack fillers
        }

        // Initialize or refill the queue if empty
        if (fillerQueueRef.current.length === 0) {
            console.log("Refilling filler queue...");
            fillerQueueRef.current = [...fillerFilesRef.current].sort(() => Math.random() - 0.5);
        }

        const nextFile = fillerQueueRef.current.pop();
        console.log(`Playing filler: ${nextFile} (${fillerQueueRef.current.length} left in queue)`);

        const audio = new Audio(`${SOCKET_URL}/slova/${nextFile}`);
        fillerAudioRef.current = audio;
        audio.volume = 0.45;

        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(e => {
                if (e.name !== 'AbortError') {
                    console.error("Filler play error:", e);
                    fillerAudioRef.current = null;
                    // Try next filler if current one fails
                    if (isWaitingForResponseRef.current) {
                        setTimeout(playFillerSound, 100);
                    }
                }
            });
        }

        audio.onended = () => {
            console.log("Filler ended.");
            fillerAudioRef.current = null;
            if (isWaitingForResponseRef.current) {
                // Short delay to avoid call stack issues and give a tiny breather
                setTimeout(playFillerSound, 50);
            }
        };
    };

    const stopFillerSound = () => {
        if (fillerAudioRef.current) {
            // We don't strictly need to wait for the promise here,
            // but calling pause() will trigger the catch block in playFillerSound.
            fillerAudioRef.current.pause();
            fillerAudioRef.current = null;
        }
    };

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const handleSendMessage = async (textToSend) => {
        if (!textToSend || !textToSend.trim() || isLoading) return;
        if (!socketConnected) {
            setMessages(prev => [...prev, { role: 'system_error', content: 'Error: Nexus Core offline.' }]);
            return;
        }

        // Reset Audio Queue for new message
        if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current = null;
        }
        if (typewriterRef.current) {
            clearInterval(typewriterRef.current);
            typewriterRef.current = null;
        }
        audioQueueRef.current = {};
        nextExpectedIndexRef.current = 0;
        isPlayingRef.current = false;

        // Reset interruption flag for new turn
        isInterruptedRef.current = false;

        setIsLoading(true);

        // Add User Message
        const newMessage = { role: 'user', content: textToSend };
        setMessages(prev => [...prev, newMessage]);

        // Prepare History
        const apiHistory = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.content })); // Sanitized

        // Emit to Socket
        socketRef.current.emit('chat_message', {
            message: textToSend,
            history: apiHistory
        });

        // Start filler sound
        isWaitingForResponseRef.current = true;
        playFillerSound();

        // We will receive 'text_chunk' events shortly
    };

    // --- STT LOGIC (Keep existing /transcribe POST) ---
    const startRecording = async () => {
        // if (isLoading) return; // Allow interruption

        // Interruption Logic
        if (isLoading || isPlayingRef.current) {
            console.log("Interrupting previous response...");
            socketRef.current.emit('interrupt');

            // Stop Audio
            if (currentAudioRef.current) {
                currentAudioRef.current.pause();
                currentAudioRef.current = null;
            }

            // Stop Filler
            stopFillerSound();
            isWaitingForResponseRef.current = false;

            // Stop Typing
            if (typewriterRef.current) {
                clearInterval(typewriterRef.current);
                typewriterRef.current = null;
            }

            // Clear Playback Queue
            audioQueueRef.current = {};
            isPlayingRef.current = false;

            // Allow new request to start fresh
            setIsLoading(false);
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) audioChunksRef.current.push(event.data);
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                await sendAudioToBackend(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (err) {
            console.error("Microphone access denied:", err);
            setMessages(prev => [...prev, { role: 'system_error', content: 'Error: Microphone access denied.' }]);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const sendAudioToBackend = async (blob) => {
        setIsLoading(true); // Temporary loading state for STT
        isWaitingForResponseRef.current = true;
        playFillerSound();
        try {
            const formData = new FormData();
            formData.append('file', blob, 'recording.wav');

            const response = await fetch(`${SOCKET_URL}/transcribe`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error(await response.text());

            const data = await response.json();

            // Wait, we are about to switch to Socket flow.
            // Reset loading here because handleSendMessage will set it again? 
            // Actually handleSendMessage checks `isLoading`. We should set it false before calling.
            setIsLoading(false);

            if (data.text) {
                await handleSendMessage(data.text);
            } else {
                isWaitingForResponseRef.current = false;
                stopFillerSound();
                setMessages(prev => [...prev, { role: 'system_error', content: 'Voice unrecognizable.' }]);
            }

        } catch (error) {
            console.error("Transcription error:", error);
            isWaitingForResponseRef.current = false;
            stopFillerSound();
            setMessages(prev => [...prev, { role: 'system_error', content: 'Error: Voice processing failed.' }]);
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-screen w-full max-w-md mx-auto bg-[#121212] text-[#E0E0E0] font-sans overflow-hidden border-x border-[#222831] shadow-2xl">
            {/* HEADER */}
            <header className="border-b border-[#222831] bg-[#121212] shadow-md z-10 p-4">
                <h1 className="text-center text-2xl font-bold tracking-[0.2em] text-[#00ADB5] uppercase" style={{ fontFamily: 'Helvetica, sans-serif' }}>
                    N E X U S
                </h1>
                <div className="text-center text-[10px] text-gray-600 tracking-widest mt-1">
                    {socketConnected ? 'SYSTEM ONLINE' : 'CONNECTING...'}
                </div>
            </header>

            {/* CHAT AREA */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[#222831] scrollbar-track-transparent">
                <div className="w-full p-4 space-y-4">
                    {messages.map((msg, index) => {
                        const isUser = msg.role === 'user';
                        const isSystem = msg.role.startsWith('system') || msg.role === 'system_error';

                        let contentClass = "whitespace-pre-wrap font-mono text-sm leading-relaxed";
                        let senderLabel = "";

                        if (isUser) {
                            contentClass += " text-[#00ADB5]";
                            senderLabel = "You > ";
                        } else if (isSystem) {
                            contentClass += " text-[#757575] italic text-xs";
                            senderLabel = ">> ";
                            if (msg.role === 'system_error') contentClass += " text-[#D62828]";
                        } else {
                            contentClass += " text-[#E0E0E0]";
                            senderLabel = "Nexus: ";
                        }

                        return (
                            <div key={index} className="flex w-full animate-in fade-in duration-300">
                                <div className="w-full">
                                    <span className={`font-bold mr-2 select-none opacity-50 ${isUser ? 'text-[#00ADB5]' : (isSystem ? 'text-gray-600' : 'text-gray-500')}`}>
                                        {senderLabel}
                                    </span>
                                    <span className={contentClass}>
                                        {msg.content}
                                    </span>
                                </div>
                            </div>
                        );
                    })}

                    {/* Loading Indicator */}
                    {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
                        <div className="flex w-full animate-pulse">
                            <span className="font-mono text-xs text-[#00ADB5]">{isRecording ? 'Listening...' : 'Nexus is thinking...'}</span>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* CONTROLS */}
            <div className="p-4 bg-[#121212] border-t border-[#222831] space-y-4">
                <button
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={stopRecording}
                    onTouchStart={startRecording}
                    onTouchEnd={stopRecording}
                    disabled={!socketConnected}
                    className={`
                        w-full py-6 font-bold tracking-widest uppercase transition-all duration-200 text-sm border
                        ${isRecording
                            ? 'bg-[#D62828]/20 text-[#D62828] border-[#D62828] shadow-[0_0_20px_rgba(214,40,40,0.3)]'
                            : 'bg-[#1a1e24] text-[#00ADB5] border-[#222831] hover:bg-[#222831] hover:text-[#00D4E0] hover:border-[#00ADB5]/50'
                        }
                        ${(!socketConnected) ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                    style={{ fontFamily: 'Helvetica, sans-serif' }}
                >
                    {isRecording ? '• LISTENING •' : 'HOLD TO SPEAK'}
                </button>

                <button
                    onClick={() => setMessages([{ role: 'system_display', content: 'Memory wiped. Context reset.' }])}
                    className="w-full py-2 font-bold tracking-widest uppercase transition-all duration-200 text-[10px] bg-[#1a1e24] text-[#FF5722] border border-[#222831] hover:bg-[#222831] hover:text-[#ff8a65] hover:border-[#FF5722]/50 opacity-60 hover:opacity-100"
                    style={{ fontFamily: 'Helvetica, sans-serif' }}
                >
                    RESET CONTEXT
                </button>
            </div>
        </div>
    );
};

export default NexusChat;