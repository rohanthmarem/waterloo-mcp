import sys,json
from faster_whisper import WhisperModel
model=WhisperModel('base.en',device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,download_root='/state/models')
segments,info=model.transcribe(sys.argv[1],language='en',beam_size=5,vad_filter=True)
print(json.dumps({'language':info.language,'segments':[{'start':s.start,'end':s.end,'text':s.text} for s in segments]}))
