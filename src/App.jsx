import React, { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';

// --- CONFIG ---
const SOCKET_URL = 'http://localhost:3001';

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

    // --- AUDIO QUEUE SYSTEM ---
    const audioQueueRef = useRef({}); // Using object for indexed storage
    const isPlayingRef = useRef(false);
    const nextExpectedIndexRef = useRef(0); // Sequence tracker
    const currentAudioRef = useRef(null); // To stop audio if needed

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

        // --- REAL-TIME STREAMING EVENTS ---

        // 1. TEXT STREAM
        socketRef.current.on('text_chunk', (chunk) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isFinal) {
                    // Update existing message
                    const updatedMsg = { ...lastMsg, content: lastMsg.content + chunk };
                    return [...prev.slice(0, -1), updatedMsg];
                } else {
                    // New chunk for a new message block (or first chunk)
                    // If the very last message was user, we add a new assistant message
                    if (prev.length > 0 && prev[prev.length - 1].role === 'user') {
                        return [...prev, { role: 'assistant', content: chunk, isFinal: false }];
                    }
                    // If we already have an assistant message that was marked final (unlikely in stream) or system
                    // Just append to the last one if it's assistant, otherwise new
                    if (lastMsg.role === 'assistant') {
                        return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + chunk }];
                    }
                    return [...prev, { role: 'assistant', content: chunk, isFinal: false }];
                }
            });
            scrollToBottom();
        });

        // 2. AUDIO STREAM
        socketRef.current.on('audio_chunk', (data) => {
            // data: { audio: base64, text: string, index: number }
            const byteCharacters = atob(data.audio);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'audio/webm' });

            // Store in indexed queue
            audioQueueRef.current[data.index] = blob;

            // Check if we can play
            if (!isPlayingRef.current) {
                playNextAudio();
            }
        });

        socketRef.current.on('stream_end', () => {
            setIsLoading(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    // Mark as final
                    return [...prev.slice(0, -1), { ...lastMsg, isFinal: true }];
                }
                return prev;
            });
        });

        socketRef.current.on('error', (err) => {
            console.error("Socket Error:", err);
            setMessages(prev => [...prev, { role: 'system_error', content: `Error: ${err}` }]);
            setIsLoading(false);
        });

        return () => {
            socketRef.current.disconnect();
        };
    }, []);

    // --- AUDIO PLAYBACK LOGIC ---
    const queueAudio = (blob) => {
        audioQueueRef.current.push(blob);
        if (!isPlayingRef.current) {
            playNextAudio();
        }
    };

    const playNextAudio = async () => {
        const index = nextExpectedIndexRef.current;
        const blob = audioQueueRef.current[index];

        if (!blob) {
            isPlayingRef.current = false;
            return;
        }

        isPlayingRef.current = true;
        // Remove from queue once we start playing it
        delete audioQueueRef.current[index];
        nextExpectedIndexRef.current++;

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudioRef.current = audio;

        audio.onended = () => {
            URL.revokeObjectURL(url);
            currentAudioRef.current = null;
            playNextAudio();
        };

        audio.onerror = (e) => {
            console.error("Audio playback error", e);
            URL.revokeObjectURL(url);
            currentAudioRef.current = null;
            playNextAudio();
        };

        try {
            await audio.play();
        } catch (e) {
            console.error("Autoplay failed", e);
            isPlayingRef.current = false;
            currentAudioRef.current = null;
            playNextAudio();
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
        audioQueueRef.current = {};
        nextExpectedIndexRef.current = 0;
        isPlayingRef.current = false;

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

        // We will receive 'text_chunk' events shortly
    };

    // --- STT LOGIC (Keep existing /transcribe POST) ---
    const startRecording = async () => {
        if (isLoading) return;
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
        try {
            const formData = new FormData();
            formData.append('file', blob, 'recording.wav');

            const response = await fetch('http://localhost:3001/transcribe', {
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
                setMessages(prev => [...prev, { role: 'system_error', content: 'Voice unrecognizable.' }]);
            }

        } catch (error) {
            console.error("Transcription error:", error);
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
                    disabled={isLoading && !isRecording}
                    className={`
                        w-full py-6 font-bold tracking-widest uppercase transition-all duration-200 text-sm border
                        ${isRecording
                            ? 'bg-[#D62828]/20 text-[#D62828] border-[#D62828] shadow-[0_0_20px_rgba(214,40,40,0.3)]'
                            : 'bg-[#1a1e24] text-[#00ADB5] border-[#222831] hover:bg-[#222831] hover:text-[#00D4E0] hover:border-[#00ADB5]/50'
                        }
                        ${(isLoading && !isRecording) ? 'opacity-50 cursor-not-allowed' : ''}
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